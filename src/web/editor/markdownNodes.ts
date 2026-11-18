import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Text } from '@codemirror/state';
import type { Root, RootContent } from 'mdast';
import type { SourceRange } from './types';

export type MarkdownNode = SourceRange & {
  readonly node: Root | RootContent;
};

type MarkdownDocument = {
  readonly source: string;
  readonly nodes: readonly MarkdownNode[];
  readonly definitions: ReadonlyMap<string, string>;
  readonly definitionSource: string;
};

// CodeMirror сохраняет тот же Text при изменении выделения или настроек.
const documents = new WeakMap<Text, MarkdownDocument>();

function readMarkdown(source: string): MarkdownDocument {
  const nodes: MarkdownNode[] = [];
  const definitions = new Map<string, string>();
  const definitionLines: string[] = [];
  const visit = (node: Root | RootContent) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from !== undefined && to !== undefined) nodes.push({ node, from, to });
    if (node.type === 'definition') {
      definitions.set(node.identifier.toUpperCase(), node.url);
      if (from !== undefined && to !== undefined) definitionLines.push(source.slice(from, to));
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(fromMarkdown(source));
  return { source, nodes, definitions, definitionSource: definitionLines.join('\n') };
}

export function markdownDocument(doc: Text | string): MarkdownDocument {
  if (typeof doc === 'string') return readMarkdown(doc);
  const cached = documents.get(doc);
  if (cached) return cached;
  const document = readMarkdown(doc.toString());
  documents.set(doc, document);
  return document;
}
