/**
 * Скачивание SVG-диаграмм файлом и служебные преобразования SVG-строк.
 *
 * SVG приходит от mermaid.render / bpmn-js viewer.saveSVG — санитизация уже
 * выполнена при рендере (mermaid securityLevel: 'strict', bpmn-js отдаёт
 * только отрисованный DOM). mermaid-строка дополнительно нормализуется к
 * строгому XML: mermaid собирает SVG HTML-сериализацией, и void-теги внутри
 * foreignObject (<br> в многострочных метках) остаются незакрытыми — скачанный
 * файл браузер открывает XML-парсером и падает с "tag mismatch".
 * PNG-экспорт живёт на сервере (rest.ts: .../png — playwright-скриншот с
 * omitBackground): клиентский canvas-путь невозможен — SVG с foreignObject
 * «портит» canvas (tainted) и toBlob запрещён.
 */

/**
 * Привести SVG-строку к валидному XML: парсим снисходительно (как HTML),
 * сериализуем строго (XMLSerializer закрывает все void-теги).
 * Возвращает исходную строку, если <svg> в ней не найден.
 */
export function normalizeSvgXml(svg: string): string {
  const host = document.createElement('div');
  host.innerHTML = svg;
  const svgElement = host.querySelector('svg');
  if (svgElement === null) {
    return svg;
  }
  return new XMLSerializer().serializeToString(svgElement);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Скачать SVG-диаграмму файлом (Blob + a.download, как downloadBlob в api.ts). */
export function downloadDiagramSvg(svg: string, filename: string): void {
  saveBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), filename);
}

/** Скачать текстовый файл (например, BPMN XML) с заданным MIME-типом. */
export function downloadTextFile(content: string, filename: string, mime: string): void {
  saveBlob(new Blob([content], { type: `${mime};charset=utf-8` }), filename);
}

/**
 * Имя файла для скачанной диаграммы по заголовку страницы.
 * Заголовок превращается в slug: латиница/кириллица/цифры → дефисы, lowercase,
 * обрезка до 60 символов. Пустой заголовок → 'diagram'. К блоку всегда
 * дописывается '-' + blockId + '.' + расширение.
 */
export function diagramFilename(
  pageTitle: string | undefined,
  blockId: string,
  ext: 'svg' | 'png' | 'bpmn' | 'drawio' = 'svg'
): string {
  const slug = (pageTitle ?? '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug.length > 0 ? slug : 'diagram'}-${blockId}.${ext}`;
}

/**
 * Статичная версия mermaid-SVG для вставки на онлайн-борды (Miro и т.п.).
 * Две причины «живого» поведения у исходного вывода mermaid:
 *  1) корень width="100%" + style max-width — SVG тянется за контейнером
 *     и переразмеривается при зуме доски;
 *  2) <style> с @keyframes и классами .edge-animation-* — анимация пунктира
 *     рёбер, которую редакторы досок проигрывают сами.
 * Фиксируем размер по viewBox и вырезаем анимационный CSS; содержимое не трогаем.
 */
export function staticSvgMarkup(svg: string): string {
  const normalized = normalizeSvgXml(svg);
  const host = document.createElement('div');
  host.innerHTML = normalized;
  const svgElement = host.querySelector('svg');
  if (svgElement === null) {
    return normalized;
  }
  const viewBox = (svgElement.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox.length === 4 && Number.isFinite(viewBox[2]) && Number.isFinite(viewBox[3])) {
    svgElement.setAttribute('width', String(viewBox[2]));
    svgElement.setAttribute('height', String(viewBox[3]));
  }
  svgElement.removeAttribute('style');
  const styleElement = svgElement.querySelector('style');
  if (styleElement !== null && styleElement.textContent !== null) {
    styleElement.textContent = stripAnimationCss(styleElement.textContent);
  }
  return new XMLSerializer().serializeToString(svgElement);
}

/** Вырезать из CSS диаграммы анимации: @keyframes, правила edge-animation, animation-свойства. */
function stripAnimationCss(css: string): string {
  const withoutKeyframes = css.replace(
    /@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g,
    ''
  );
  const withoutAnimationRules = withoutKeyframes
    .split('}')
    .filter((rule) => !rule.includes('edge-animation'))
    .map((rule) => rule.replace(/animation(?:-[a-z]+)?\s*:[^;]*;?/gi, ''));
  return withoutAnimationRules.join('}');
}
