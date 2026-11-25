import type { Text } from '@codemirror/state';
import { markdownDocument } from './markdownNodes';
import type { SourceRange } from './types';

export type EditorLink = SourceRange & {
  readonly target: string;
  readonly label: string;
  readonly labelFrom: number;
  readonly labelTo: number;
  readonly wiki: boolean;
};

const linksByDoc = new WeakMap<Text, readonly EditorLink[]>();

export function parseEditorLinks(doc: Text | string): readonly EditorLink[] {
  if (typeof doc === 'string') return collectLinks(doc);
  const cached = linksByDoc.get(doc);
  if (cached) return cached;
  const links = collectLinks(doc);
  linksByDoc.set(doc, links);
  return links;
}

function collectLinks(doc: Text | string): readonly EditorLink[] {
  const { slice, nodes, definitions, wikiLinks } = markdownDocument(doc);
  const links: EditorLink[] = [];
  const excluded: SourceRange[] = [];
  for (const { node, from, to, offset } of nodes) {
    switch (node.type) {
      case 'code':
      case 'inlineCode':
      case 'html':
      case 'definition':
      case 'image':
      case 'imageReference': excluded.push({ from, to }); break;
      case 'link':
      case 'linkReference': {
        excluded.push({ from, to });
        const target = node.type === 'link' ? node.url : definitions.get(node.identifier.toUpperCase());
        const first = node.children[0]?.position?.start.offset;
        const last = node.children.at(-1)?.position?.end.offset;
        if (target && first !== undefined && last !== undefined) {
          const labelFrom = first + offset;
          const labelTo = last + offset;
          links.push({ from, to, target, label: slice(labelFrom, labelTo), labelFrom, labelTo, wiki: false });
        }
        break;
      }
    }
  }
  for (const { from, to, value } of wikiLinks) {
    if (excluded.some(range => from < range.to && to > range.from)) continue;
    const separator = value.indexOf('|');
    const target = separator < 0 ? value : value.slice(0, separator);
    const labelFrom = from + 2 + (separator < 0 ? 0 : separator + 1);
    if (target) links.push({
      from, to, target, label: slice(labelFrom, to - 2),
      labelFrom, labelTo: to - 2, wiki: true
    });
  }
  return links.sort((left, right) => left.from - right.from);
}
