import { parseEditorDiagrams } from './parseDiagrams';
import type { EditorDiagram } from './types';

type RenameResult = { readonly text: string } | { readonly error: string };
const invalidEmbed = 'Не удалось изменить название в этой Markdown-вставке.';

function labelEnd(markdown: string): number {
  let depth = 1;
  for (let i = 2; i < markdown.length; i++) {
    if (markdown[i] === '\\') i++;
    else if (markdown[i] === '[') depth++;
    else if (markdown[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

export function renameDiagramEmbed(source: string, diagram: EditorDiagram, title: string): RenameResult {
  const raw = source.slice(diagram.from, diagram.to);
  let text: string;
  if (raw.startsWith('![[') && raw.endsWith(']]')) {
    if (/[\[\]|]/.test(title)) return { error: 'Название не должно содержать квадратные скобки или вертикальную черту.' };
    const inner = raw.slice(3, -2);
    const separator = inner.indexOf('|');
    const path = separator === -1 ? inner : inner.slice(0, separator);
    text = `![[${path}|${title}]]`;
  } else if (raw.startsWith('![')) {
    const end = labelEnd(raw);
    if (end === -1) return { error: invalidEmbed };
    const suffix = raw.slice(end + 1);
    // У сокращённой ссылки прежняя подпись служит идентификатором определения.
    const link = suffix === '' || suffix === '[]' ? `[${raw.slice(2, end)}]` : suffix;
    const escaped = title.replace(/[\\[\]`*_!&<>]/g, '\\$&');
    text = `![${escaped}]${link}`;
  } else return { error: invalidEmbed };

  const updated = `${source.slice(0, diagram.from)}${text}${source.slice(diagram.to)}`;
  const match = parseEditorDiagrams(updated).find(item => item.from === diagram.from && item.to === diagram.from + text.length);
  return match?.target === diagram.target && match?.label === title ? { text } : { error: invalidEmbed };
}
