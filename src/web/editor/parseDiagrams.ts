import type { Text } from '@codemirror/state';
import type { EditorDiagram, SourceRange } from './types';
import { markdownDocument } from './markdownNodes';

const diagramsByDoc = new WeakMap<Text, readonly EditorDiagram[]>();

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

export function parseEditorDiagrams(doc: Text | string): readonly EditorDiagram[] {
  if (typeof doc === 'string') return collectDiagrams(doc);
  const cached = diagramsByDoc.get(doc);
  if (cached) return cached;
  const diagrams = collectDiagrams(doc);
  diagramsByDoc.set(doc, diagrams);
  return diagrams;
}

function collectDiagrams(doc: Text | string): readonly EditorDiagram[] {
  const { slice, nodes, definitions, wikiEmbeds } = markdownDocument(doc);
  const diagrams: EditorDiagram[] = [];
  const excluded: SourceRange[] = [];
  for (const { node, from, to } of nodes) {
    switch (node.type) {
      case 'code': {
        excluded.push({ from, to });
        const raw = slice(from, to);
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
  for (const { from, to, value } of wikiEmbeds) {
    if (excluded.some(range => from < range.to && to > range.from)) continue;
    const [target = '', label] = value.split('|', 2);
    const format = externalDiagram(target);
    if (format) diagrams.push({
      from, to, format, source: '', target,
      ...(label !== undefined ? { label } : {})
    });
  }
  return diagrams.sort((left, right) => left.from - right.from);
}
