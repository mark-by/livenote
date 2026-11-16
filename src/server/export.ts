/**
 * Экспорт страниц LiveNote обратно в Markdown.
 * Формат согласован с import.ts: первая строка — `# Заголовок`,
 * markdown-блоки идут как есть, диаграммы (mermaid, bpmn, drawio) — в ограждённых
 * блоках с исходником без фенсов.
 */
import type { BlockType, PageFull } from '../shared/types.js';

/** Тип блока, экспортируемый как fenced-блок ```<тип>. */
type DiagramBlockType = 'mermaid' | 'bpmn' | 'drawio';

/** Метка fenced-блока для диаграммного блока; undefined — обычный markdown-блок. */
function diagramFenceTag(type: BlockType): DiagramBlockType | undefined {
  return type === 'mermaid' || type === 'bpmn' || type === 'drawio' ? type : undefined;
}

/**
 * Длина ограждения: минимум 3 бэктика, но длиннее, чем самый длинный ряд
 * бэктиков внутри исходника (иначе фенс оборвётся раньше времени).
 */
function fenceLength(source: string): number {
  let longest = 0;
  for (const run of source.matchAll(/`+/g)) {
    const text = run[0] ?? '';
    longest = Math.max(longest, text.length);
  }
  return Math.max(3, longest + 1);
}

/** Экранирование названия для info-string fenced-блока: backslash и кавычка. */
function escapeTitleAttr(title: string): string {
  return title.replace(/[\\"]/g, (ch) => `\\${ch}`);
}

/** Диаграммный блок в виде fenced-блока ```<тип> ... ```; название — в info-string: ```mermaid title="...". */
function fencedDiagram(type: DiagramBlockType, source: string, title: string | null): string {
  const fence = '`'.repeat(fenceLength(source));
  const label = title !== null && title !== '' ? ` title="${escapeTitleAttr(title)}"` : '';
  return `${fence}${type}${label}\n${source}\n${fence}`;
}

/** Экспорт одной страницы: заголовок + блоки по порядку, разделённые пустой строкой. */
export function exportPageMarkdown(page: PageFull): string {
  const sections: string[] = [`# ${page.title}`];
  for (const block of page.blocks) {
    const fenceTag = diagramFenceTag(block.type);
    sections.push(fenceTag !== undefined ? fencedDiagram(fenceTag, block.source, block.title) : block.source);
  }
  // Финальный перевод строки в конце документа.
  return sections.join('\n\n') + '\n';
}

/** Экспорт всего блокнота: страницы через горизонтальный разделитель. */
export function exportAllMarkdown(pages: PageFull[]): string {
  return pages.map((page) => exportPageMarkdown(page)).join('\n\n---\n\n');
}
