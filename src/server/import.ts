/**
 * Импорт Markdown-документа в страницу LiveNote.
 * Разбор зеркален export.ts: `# Заголовок` становится названием страницы,
 * fenced-блоки ```mermaid, ```bpmn и ```drawio превращаются в блоки соответствующего типа,
 * остальное — markdown-блоки.
 */
import type { NewBlock } from './db.js';

/** Открывающий фенс диаграммы: 3+ бэктика, тип, необязательное название в info-string (title="..." с \\-экранированием). */
const DIAGRAM_OPEN = /^\s*(`{3,})(mermaid|bpmn|drawio)(?:\s+title="((?:\\.|[^"\\])*)")?\s*$/;
/** Закрывающий фенс: только бэктики и пробелы; длина проверяется против открывающего. */
const FENCE_CLOSE = /^\s*(`{3,})\s*$/;
/** Заголовок документа — ровно один `#` с пробелом. */
const TITLE_LINE = /^# (.+)$/;

/** Результат разбора Markdown для POST /api/import. */
export interface ParsedMarkdown {
  title?: string;
  blocks: NewBlock[];
}

/**
 * Разобрать Markdown-текст на блоки страницы.
 * Скан построчный: вне фенсов копим markdown, встретили ```mermaid или ```bpmn —
 * копим диаграмму до закрывающего фенса не меньшей длины. Markdown-куски
 * сбрасываются при встрече фенса или в конце документа; пустые (после trim)
 * куски не дают блоков.
 */
export function parseMarkdownToBlocks(content: string): ParsedMarkdown {
  const lines = content.split(/\r\n|\r|\n/);

  // Заголовок документа: первая содержательная строка вида `# ...`.
  let title: string | undefined;
  let titleLineIndex = -1;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      continue;
    }
    const match = TITLE_LINE.exec(line);
    if (match) {
      const candidate = (match[1] ?? '').trim();
      if (candidate !== '') {
        title = candidate;
        titleLineIndex = index; // Строка заголовка вырезается из первого markdown-блока.
      }
    }
    break;
  }

  const blocks: NewBlock[] = [];
  let markdown: string[] = [];
  /** Накопитель fenced-диаграммы: тип блока, строки исходника, длина открывающего фенса. null — вне fenced-блока. */
  let diagram: { type: 'mermaid' | 'bpmn' | 'drawio'; lines: string[]; fenceLength: number; title: string | null } | null = null;

  const flushMarkdown = (): void => {
    const text = markdown.join('\n').trim();
    if (text !== '') {
      blocks.push({ type: 'markdown', source: text });
    }
    markdown = [];
  };

  const flushDiagram = (trim: boolean): void => {
    if (diagram === null) {
      return;
    }
    const source = diagram.lines.join('\n');
    const clean = trim ? source.trim() : source;
    if (clean !== '') {
      blocks.push({ type: diagram.type, source: clean, title: diagram.title });
    }
    diagram = null;
  };

  for (const [index, line] of lines.entries()) {
    if (index === titleLineIndex) {
      continue; // Строку заголовка не включаем в содержимое блоков.
    }
    if (diagram === null) {
      const open = DIAGRAM_OPEN.exec(line);
      if (open) {
        flushMarkdown();
        diagram = {
          type: open[2] === 'bpmn' ? 'bpmn' : open[2] === 'drawio' ? 'drawio' : 'mermaid',
          lines: [],
          fenceLength: open[1]?.length ?? 3,
          title: open[3] !== undefined ? open[3].replace(/\\(["\\])/g, '$1') : null
        };
      } else {
        markdown.push(line);
      }
    } else {
      const close = FENCE_CLOSE.exec(line);
      if (close && (close[1]?.length ?? 0) >= diagram.fenceLength) {
        flushDiagram(false);
      } else {
        diagram.lines.push(line);
      }
    }
  }

  // Незакрытый фенс: дописываем накопленное как диаграмму (без trim потеряем смысл, с trim — безопаснее).
  flushDiagram(true);
  flushMarkdown();

  return { title, blocks };
}
