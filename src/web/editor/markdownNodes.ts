import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Root, RootContent } from 'mdast';
import type { SourceRange } from './types';

export type MarkdownNode = SourceRange & {
  readonly node: Root | RootContent;
};

export function markdownNodes(source: string): readonly MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  const visit = (node: Root | RootContent) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from !== undefined && to !== undefined) nodes.push({ node, from, to });
    if ('children' in node) node.children.forEach(visit);
  };
  visit(fromMarkdown(source));
  return nodes;
}
