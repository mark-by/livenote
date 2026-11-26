import { markdownLanguage } from '@codemirror/lang-markdown';
import type { Text } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { SourceRange } from './types';

export interface DetailsSource extends SourceRange {
  readonly summary: string;
  readonly open: boolean;
  readonly bodyFrom: number;
  readonly bodyTo: number;
  readonly bodyIndent: number;
  readonly summaryRange?: SourceRange;
}

const tags = /<(\/?)(details|summary)(?=[\t\n\f\r >])((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi;
const attributes = /([^\s"'=<>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const literalNodes = new Set(['CodeBlock', 'FencedCode', 'InlineCode', 'Comment', 'CommentBlock', 'URL', 'LinkTitle']);
const rangesByDoc = new WeakMap<Text, readonly DetailsSource[]>();
type Tag = SourceRange & { readonly name: string; readonly closing: boolean; readonly attributes: string };
type VisibleTag = Tag & { readonly node: SyntaxNode };
type Opening = { readonly tag: VisibleTag; readonly header: Header | undefined };
type TagPair = { readonly opening: Opening; readonly closing: Tag };
type Header = { readonly end: number; readonly summaryRange?: SourceRange };

export function detailsBody(source: string, indent: number): string {
  return indent ? source.replace(new RegExp(`^ {1,${indent}}`, 'gm'), '') : source;
}

function trimmedRange(source: string, opening: Tag, closing: Tag): SourceRange {
  const text = source.slice(opening.to, closing.from);
  const from = opening.to + text.length - text.trimStart().length;
  return { from, to: from + text.trim().length };
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', offset - 1) + 1;
}

function listIndent(source: string, markerEnd: number): number {
  const padding = /^ {1,4}(?=\S)/.exec(source.slice(markerEnd))?.[0].length ?? 1;
  return markerEnd - lineStart(source, markerEnd) + padding;
}

function readTags(source: string): readonly Tag[] {
  return Array.from(source.matchAll(tags), match => {
    const [raw, slash = '', name = '', attrs = ''] = match;
    const from = match.index;
    return { from, to: from + raw.length, name: name.toLowerCase(), closing: slash === '/', attributes: attrs };
  });
}

function ancestor(node: SyntaxNode, matches: (name: string) => boolean): SyntaxNode | null {
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    if (matches(current.name)) return current;
  }
  return null;
}

function escaped(source: string, position: number): boolean {
  let start = position;
  while (source[start - 1] === '\\') start--;
  return (position - start) % 2 === 1;
}

function endOfTagLine(source: string, to: number): number {
  return to + (/^[ \t]*\r?(?=\n|$)/.exec(source.slice(to))?.[0].length ?? 0);
}

function startOfTagLine(source: string, from: number): number {
  const start = lineStart(source, from);
  return /^[ \t]*$/.test(source.slice(start, from)) ? start : from;
}

function visibleTags(source: string, tree: Tree, tagsInSource: readonly Tag[]): readonly VisibleTag[] {
  const tokens: VisibleTag[] = [];
  for (const tag of tagsInSource) {
    if (escaped(source, tag.from)) continue;
    const node = tree.resolveInner(tag.from, 1);
    if (!ancestor(node, name => literalNodes.has(name))) tokens.push({ ...tag, node });
  }
  return tokens;
}

function pairDetails(source: string, tokens: readonly VisibleTag[]): readonly TagPair[] {
  const stack: Opening[] = [];
  const pairs: TagPair[] = [];
  for (const [index, tag] of tokens.entries()) {
    if (tag.name !== 'details') continue;
    if (!tag.closing) {
      stack.push({ tag, header: readHeader(source, tag, tokens[index + 1], tokens[index + 2]) });
      continue;
    }
    const opening = stack.pop();
    if (opening) pairs.push({ opening, closing: tag });
  }
  return pairs;
}

function readHeader(source: string, opening: Tag, start?: Tag, end?: Tag): Header | undefined {
  if (start?.name !== 'summary' || start.closing || source.slice(opening.to, start.from).trim()) {
    return { end: opening.to };
  }
  if (end?.name !== 'summary' || !end.closing) return undefined;
  return { end: end.to, summaryRange: trimmedRange(source, start, end) };
}

function labelFor(source: string, range: SourceRange | undefined): string {
  const label = range && source.slice(range.from, range.to).replace(/\s+/g, ' ');
  return label || 'Подробности';
}

function makeRange(source: string, opening: Tag, closing: Tag, header: Header, node: SyntaxNode): DetailsSource {
  const headerLineEnd = endOfTagLine(source, header.end);
  const bodyFrom = source[headerLineEnd] === '\n' ? headerLineEnd + 1 : header.end;
  const listMark = ancestor(node, name => name === 'ListItem')?.getChild('ListMark');
  return {
    from: startOfTagLine(source, opening.from),
    to: endOfTagLine(source, closing.to),
    bodyFrom,
    bodyTo: Math.max(bodyFrom, startOfTagLine(source, closing.from)),
    bodyIndent: listMark ? listIndent(source, listMark.to) : 0,
    summary: labelFor(source, header.summaryRange),
    ...header.summaryRange && { summaryRange: header.summaryRange },
    open: Array.from(opening.attributes.matchAll(attributes)).some(match => match[1]?.toLowerCase() === 'open'),
  };
}

function outerRanges(blocks: DetailsSource[]): readonly DetailsSource[] {
  const outermost: DetailsSource[] = [];
  for (const block of blocks.sort((a, b) => a.from - b.from)) {
    if (block.from >= (outermost[outermost.length - 1]?.to ?? 0)) outermost.push(block);
  }
  return outermost;
}

function readDetails(source: string): readonly DetailsSource[] {
  const tagsInSource = readTags(source);
  if (!tagsInSource.length) return [];
  // Убираем только синтаксис тегов, чтобы Markdown увидел вложенные блоки кода и списки.
  const tree = markdownLanguage.parser.parse(source.replace(tags, tag => tag.replace(/[^\r\n]/g, 'x')));
  const blocks: DetailsSource[] = [];
  for (const { opening: { tag, header }, closing } of pairDetails(source, visibleTags(source, tree, tagsInSource))) {
    if (header) blocks.push(makeRange(source, tag, closing, header, tag.node));
  }
  return outerRanges(blocks);
}

export function detailsRanges(doc: Text | string): readonly DetailsSource[] {
  if (typeof doc === 'string') return readDetails(doc);
  const cached = rangesByDoc.get(doc);
  if (cached) return cached;
  const blocks = readDetails(doc.toString());
  rangesByDoc.set(doc, blocks);
  return blocks;
}
