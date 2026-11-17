import type { EditorDiagram, SourceRange } from './types';
import { markdownNodes } from './markdownNodes';

function externalDiagram(target: string): EditorDiagram['format'] | undefined {
  let destination: string;
  try { destination = decodeURIComponent(target); }
  catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
  if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(destination)) return undefined;
  switch (destination.split('.').at(-1)?.toLowerCase()) {
    case 'mmd':
    case 'mermaid': return 'mermaid';
    case 'bpmn': return 'bpmn';
    case 'drawio': return 'drawio';
    default: return undefined;
  }
}

export function parseEditorDiagrams(source: string): readonly EditorDiagram[] {
  const nodes = markdownNodes(source);
  const definitions = new Map<string, string>();
  for (const { node } of nodes) {
    if (node.type === 'definition') definitions.set(node.identifier.toUpperCase(), node.url);
  }
  const diagrams: EditorDiagram[] = [];
  const excluded: SourceRange[] = [];
  for (const { node, from, to } of nodes) {
    switch (node.type) {
      case 'code': {
        excluded.push({ from, to });
        const raw = source.slice(from, to);
        const opening = /^ {0,3}(`{3,}|~{3,})mermaid[^\r\n]*(?:\r?\n)/.exec(raw);
        if (node.lang !== 'mermaid' || !opening) break;
        const fence = opening[1] ?? '';
        const lastNewline = raw.lastIndexOf('\n');
        const lastLine = raw.slice(lastNewline + 1).trim();
        const closed = lastLine.length >= fence.length &&
          [...lastLine].every(char => char === fence[0]);
        const contentEnd = closed ? lastNewline - (raw[lastNewline - 1] === '\r' ? 1 : 0) : raw.length;
        diagrams.push({ from, to, format: 'mermaid', source: raw.slice(opening[0].length, Math.max(opening[0].length, contentEnd)) });
        break;
      }
      case 'inlineCode':
      case 'html': excluded.push({ from, to }); break;
      case 'image':
      case 'imageReference': {
        excluded.push({ from, to });
        const target = node.type === 'image' ? node.url : definitions.get(node.identifier.toUpperCase());
        const format = target ? externalDiagram(target) : undefined;
        if (target && format) diagrams.push({ from, to, format, source: '', target, label: node.alt ?? '' });
        break;
      }
    }
  }
  for (const match of source.matchAll(/!\[\[([^\]\r\n]+)\]\]/g)) {
    const from = match.index;
    const to = from + match[0].length;
    let slash = from;
    while (slash > 0 && source[slash - 1] === '\\') slash--;
    if ((from - slash) % 2 || excluded.some(range => from < range.to && to > range.from)) continue;
    const [target = '', label] = (match[1] ?? '').split('|', 2);
    const format = externalDiagram(target);
    if (format) diagrams.push({
      from, to, format, source: '', target,
      ...(label !== undefined ? { label } : {})
    });
  }
  return diagrams.sort((left, right) => left.from - right.from);
}
