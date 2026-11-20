import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, expect } from 'playwright/test';

const project = fileURLToPath(new URL('../', import.meta.url));
const timeout = 45_000;
const diagram = 'flowchart TB\n' + Array.from({ length: 16 }, (_, i) => `N${i}[Узел ${i}] --> N${i + 1}`).join('\n');
const fence = source => `\`\`\`mermaid\n${source}\n\`\`\``;
const lines = prefix => Array.from({ length: 280 }, (_, i) => `${prefix} ${i}`).join('\n');
let directory;
let server;
let browser;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'livenote-diagram-browser-'));
  await writeFile(join(directory, 'index.html'), '<meta charset="UTF-8"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
  const module = file => JSON.stringify(join(project, 'src/web', file));
  await writeFile(join(directory, 'fixture.tsx'), `
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import mermaid from 'mermaid';
import {LivePreviewEditor} from ${module('editor/LivePreviewEditor.tsx')};
import {DiagramPreview} from ${module('diagrams/index.ts')};
import {setThemeOverride} from ${module('mermaidInit.ts')};
import ${module('heroui.css')};
import ${module('styles.css')};
const render = mermaid.render;
window.renders = [];
window.scrollToDiagram = (last = false) => {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
  const source = view.state.doc.toString();
  const start = last ? source.lastIndexOf('\`\`\`mermaid') : source.indexOf('\`\`\`mermaid');
  view.scrollDOM.scrollTop = view.lineBlockAt(start).top;
};
mermaid.render = (id, source, host) => {
  window.renders.push(source);
  return render(id, source, host);
};
window.mountedHeights = [];
new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) {
    if (node instanceof HTMLElement && node.matches('.lp-diagram')) {
      window.mountedHeights.push(node.getBoundingClientRect().height);
    }
  }
}).observe(document.getElementById('root'), {childList: true, subtree: true});
function Fixture() {
  const [source, setSource] = useState(window.initialSource);
  const [action, setAction] = useState('');
  const [duplicate, setDuplicate] = useState(false);
  window.setSource = setSource;
  function preview(diagram) {
    return <DiagramPreview value={{format: 'mermaid', source: diagram.source}}
      onEdit={() => setAction('Правка')} onExpand={() => setAction('Просмотр')} />;
  }
  return <>
    <button onClick={() => setThemeOverride('dark')}>Тёмная тема Mermaid</button>
    <button onClick={() => setDuplicate(true)}>Вторая копия</button>
    <output>{action}</output>
    {duplicate && <aside>{preview({source: ${JSON.stringify(diagram)}})}</aside>}
    <main style={{height: '75vh'}}>
      <LivePreviewEditor source={source} onChange={setSource} renderDiagram={preview} />
    </main>
  </>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  const aliases = ['react', 'react-dom', 'mermaid', '@codemirror/view'].map(name => [name, join(project, 'node_modules', name)]);
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: join(directory, 'cache'),
    plugins: [tailwindcss()],
    esbuild: { jsx: 'automatic' },
    resolve: { alias: Object.fromEntries(aliases) },
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [project, directory] } }
  });
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function open(t, source) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(value => { window.initialSource = value; }, source);
  await page.route('**/api/config', route => route.fulfill({ json: { mermaidTheme: 'default' } }));
  await page.goto(server.resolvedUrls.local[0]);
  await expect(page.getByRole('textbox', { name: 'Текст заметки' })).toBeVisible();
  return page;
}

const previewSvg = '.mermaid-block > div:not([class]) > svg';
const scrollToDiagram = page => page.evaluate(() => window.scrollToDiagram());
const scrollToEnd = page => page.locator('.cm-scroller').evaluate(element => { element.scrollTop = element.scrollHeight; });
const renders = page => page.evaluate(() => window.renders);
const scrollable = drawing => `${lines('До схемы')}\n\n${fence(drawing)}\n\n${lines('После схемы')}`;

test('Повторный вход в область диаграммы сразу возвращает высоту и готовый SVG', { timeout }, async t => {
  // Arrange: диаграмма выше окна и за ней достаточно строк для размонтирования.
  const page = await open(t, scrollable(diagram));
  const widget = page.locator('.lp-diagram');
  const svg = widget.locator(previewSvg);
  await expect(async () => {
    await scrollToDiagram(page);
    await expect(widget).toBeAttached({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await expect(svg).toContainText('Узел 15');
  const height = await widget.evaluate(element => element.getBoundingClientRect().height);
  assert.ok(height > 800);
  await scrollToEnd(page);
  await expect(widget).toHaveCount(0);

  // Act: наблюдатель фиксирует размер сразу после вставки контейнера.
  await page.evaluate(() => { window.mountedHeights.length = 0; });
  await scrollToDiagram(page);

  // Assert: резерв соответствует измеренной высоте, а кнопки используют новый экземпляр React.
  await expect(svg).toContainText('Узел 15');
  const [initial] = await page.evaluate(() => window.mountedHeights);
  assert.ok(Math.abs(height - initial) <= 1, `Высота при монтаже: ${initial}, до размонтирования: ${height}`);
  assert.deepEqual(await renders(page), [diagram]);
  await widget.locator('.mermaid-block').hover({ position: { x: 20, y: 20 } });
  await expect(widget.getByRole('button', { name: 'Скачать SVG' })).toBeEnabled();
  await widget.getByRole('button', { name: 'Редактировать диаграмму' }).click();
  await expect(page.locator('output')).toHaveText('Правка');
});

test('Возврат к высокой схеме не сдвигает прокрутку сверх заданного шага', { timeout }, async t => {
  // Arrange: измеряем обе схемы, затем прокручиваем до конца заметки.
  const tall = diagram + '\nN16 --> N17[Конец второй схемы]';
  const tail = lines('После схем').split('\n').slice(0, 54).join('\n');
  const page = await open(t, `${lines('До схем')}\n\n${fence(diagram)}\n\n${fence(tall)}\n\n${tail}`);
  await scrollToDiagram(page);
  await expect(page.locator(previewSvg)).toContainText('Узел 15');
  await page.evaluate(() => window.scrollToDiagram(true));
  await expect(page.locator(previewSvg).getByText('Конец второй схемы')).toBeAttached();
  await scrollToEnd(page);
  await expect(page.locator('.lp-diagram')).toHaveCount(0);

  // Act: быстро прокручиваем вверх и измеряем позицию после обновления редактора.
  const result = await page.locator('.cm-scroller').evaluate(async element => {
    const frame = () => new Promise(requestAnimationFrame);
    let largestShift = 0;
    for (let step = 0; step < 10; step++) {
      const target = element.scrollTop - 380;
      element.scrollTop = target;
      await frame();
      await frame();
      largestShift = Math.max(largestShift, Math.abs(element.scrollTop - target));
    }
    return largestShift;
  });

  // Assert: возврат готового блока не меняет позицию текста относительно окна.
  assert.ok(result <= 2, `Прокрутка отклонилась на ${result} пикселей`);
});

test('Повторный монтаж после сужения редактора не использует старую высоту', { timeout }, async t => {
  // Arrange: широкая схема сначала отображается в широком редакторе.
  const wide = 'flowchart LR\n' + Array.from({ length: 9 }, (_, i) => `N${i}[Длинная подпись узла ${i}] --> N${i + 1}`).join('\n');
  const page = await open(t, scrollable(wide));
  await scrollToDiagram(page);
  const widget = page.locator('.lp-diagram');
  await expect(widget.locator(previewSvg)).toContainText('Длинная подпись узла 8');
  const height = await widget.evaluate(element => element.getBoundingClientRect().height);
  await scrollToEnd(page);
  await expect(widget).toHaveCount(0);

  // Act: меняем ширину, пока виджет вне области рендера.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => { window.mountedHeights.length = 0; });
  await scrollToDiagram(page);

  // Assert: высота пересчитана по новой ширине. SVG масштабирует браузер.
  await expect(widget.locator(previewSvg)).toContainText('Длинная подпись узла 8');
  const [initial] = await page.evaluate(() => window.mountedHeights);
  assert.ok(initial < height - 1, `После сужения зарезервировано ${initial} из ${height} пикселей`);
  assert.ok(await widget.evaluate(element => element.getBoundingClientRect().height) < height - 1);
  assert.deepEqual(await renders(page), [wide]);
});

test('Возврат от другой схемы сразу восстанавливает высоту первой схемы', { timeout }, async t => {
  // Arrange: разместить две схемы разной высоты в непересекающихся областях просмотра.
  const prefix = `${lines('До схемы')}\n\n`;
  const second = 'flowchart LR\nA[Другая схема] --> B';
  const page = await open(t, `${prefix}${fence(diagram)}\n\n${lines('Между схемами')}\n\n${fence(second)}`);
  const firstWidget = page.locator(`.lp-diagram[data-from="${prefix.length}"]`);
  await scrollToDiagram(page);
  await expect(firstWidget.locator(previewSvg)).toContainText('Узел 15');
  const height = await firstWidget.evaluate(element => element.getBoundingClientRect().height);
  await scrollToEnd(page);
  await expect(firstWidget).toHaveCount(0);
  await expect(page.locator('.lp-diagram').locator(previewSvg)).toContainText('Другая схема');

  // Act: вернуться непосредственно от второй схемы к первой.
  await page.evaluate(() => { window.mountedHeights.length = 0; });
  await scrollToDiagram(page);

  // Assert: первая схема сохраняет высоту с момента появления.
  await expect(firstWidget.locator(previewSvg)).toContainText('Узел 15');
  const [initial] = await page.evaluate(() => window.mountedHeights);
  assert.ok(Math.abs(height - initial) <= 1, `Высота при возврате: ${initial}, до прокрутки: ${height}`);
});

test('Ввод под выгруженной схемой сохраняет позицию прокрутки', { timeout }, async t => {
  // Arrange: отрисовать высокую схему, затем уйти вниз до её выгрузки.
  const page = await open(t, scrollable(diagram));
  const widget = page.locator('.lp-diagram');
  await scrollToDiagram(page);
  await expect(widget.locator(previewSvg)).toContainText('Узел 15');
  await scrollToEnd(page);
  await expect(widget).toHaveCount(0);
  const line = page.locator('.cm-line').getByText('После схемы 279', { exact: true });
  await line.click();
  const scroller = page.locator('.cm-scroller');
  const before = await scroller.evaluate(element => element.scrollTop);

  // Act: вставить символ в последнюю видимую строку.
  await page.keyboard.press('End');
  await page.keyboard.insertText('!');
  await expect(page.getByRole('textbox', { name: 'Текст заметки' })).toContainText('После схемы 279!');
  const after = await scroller.evaluate(async element => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return element.scrollTop;
  });

  // Assert: высота выгруженной схемы не сдвинула редактируемую строку.
  assert.ok(Math.abs(before - after) <= 2, `Прокрутка изменилась с ${before} до ${after}`);
});

test('Одинаковые схемы в двух виджетах имеют разные корневые SVG ID', { timeout }, async t => {
  // Arrange: одна схема уже отображается, и её результат можно взять из кэша.
  const page = await open(t, fence(diagram));
  const first = page.locator('main').locator(previewSvg);
  await expect(first).toContainText('Узел 15');
  const id = await first.getAttribute('id');

  // Act: открываем второй экземпляр с тем же исходником.
  await page.getByRole('button', { name: 'Вторая копия' }).click();

  // Assert: первый экземпляр не изменился, а второй содержит собственный SVG.
  const second = page.locator('aside').locator(previewSvg);
  await expect(second).toContainText('Узел 15');
  await expect(first).toHaveAttribute('id', id);
  assert.notEqual(await second.getAttribute('id'), id);
});

test('Изменения исходника и темы Mermaid запускают новый рендер', { timeout }, async t => {
  // Arrange: исходник отрисован в исходной теме.
  const initial = 'flowchart TB\nA[Исходная подпись] --> B';
  const changed = 'flowchart TB\nA[Новая подпись] --> B';
  const page = await open(t, fence(initial));
  const svg = page.locator('.lp-diagram').locator(previewSvg);
  await expect(svg).toContainText('Исходная подпись');

  // Act: меняем исходник, затем тему для нового исходника.
  await page.evaluate(source => window.setSource(source), fence(changed));
  await expect(svg).toContainText('Новая подпись');
  const previousId = await svg.getAttribute('id');
  await page.getByRole('button', { name: 'Тёмная тема Mermaid' }).click();

  // Assert: кэш не возвращает прежний SVG для изменившихся параметров.
  await expect(svg).not.toHaveAttribute('id', previousId);
  await expect(svg).toContainText('Новая подпись');
  assert.deepEqual(await renders(page), [initial, changed, changed]);
});
