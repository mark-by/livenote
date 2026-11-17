import { fromMarkdown } from 'mdast-util-from-markdown';

/** Destination сохраняет исходное экранирование и title, переписывается только этот диапазон. */
export function destinationToken(raw: string, definition = false): { start: number; end: number } | null {
  let start = 0;
  if (definition) {
    const prefix = /^\s*\[[^\]]+\]:\s*/.exec(raw);
    if (!prefix) return null;
    start = prefix[0].length;
  } else {
    let depth = 0; let delimiter = -1;
    for (let i = raw.startsWith('!') ? 1 : 0; i < raw.length; i++) {
      const char = raw[i];
      if (char === '\\') { i++; continue; }
      if (char === '[') depth++;
      if (char === ']' && --depth === 0 && raw[i + 1] === '(') { delimiter = i + 2; break; }
    }
    if (delimiter < 0) return null;
    start = delimiter;
    while (/\s/.test(raw[start] ?? '')) start++;
  }
  const angled = raw[start] === '<';
  if (angled) start++;
  let end = start; let depth = 0;
  for (; end < raw.length; end++) {
    const char = raw[end];
    if (char === '\\') { end++; continue; }
    if (char === undefined || (angled ? char === '>' : /\s/.test(char) || (char === ')' && depth === 0))) break;
    if (!angled && char === '(') depth++;
    if (!angled && char === ')') depth--;
  }
  return { start, end };
}
export function markdownProse(source: string): string {
  interface TextNode { type: string; value?: string; alt?: string | null; children?: readonly TextNode[] }
  const text = (node: TextNode): string => {
    if (['html', 'code', 'inlineCode', 'link', 'definition'].includes(node.type)) return '';
    if (node.type === 'image') return node.alt ?? '';
    if (node.value !== undefined) return node.value;
    return (node.children ?? []).map(text).join(['root', 'list', 'blockquote'].includes(node.type) ? '\n' : '');
  };
  return text(fromMarkdown(source)).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label ?? target);
}
