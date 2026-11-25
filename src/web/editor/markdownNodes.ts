import { fromMarkdown } from 'mdast-util-from-markdown';
import { RangeSet, RangeValue } from '@codemirror/state';
import type { Range, Text, Transaction } from '@codemirror/state';
import type { Root, RootContent } from 'mdast';
import type { SourceRange } from './types';

type PreviewNode = Extract<RootContent, { type:
  'code' | 'inlineCode' | 'html' | 'definition' | 'image' | 'imageReference' | 'link' | 'linkReference' }>;
type MarkdownNode = SourceRange & {
  readonly node: PreviewNode;
  readonly offset: number;
};
type WikiMatch = SourceRange & { readonly value: string };

type MarkdownSpans = {
  readonly nodes: readonly MarkdownNode[];
  readonly wikiLinks: readonly WikiMatch[];
  readonly wikiEmbeds: readonly WikiMatch[];
};

type MarkdownDocument = MarkdownSpans & {
  readonly slice: (from: number, to: number) => string;
  readonly definitions: ReadonlyMap<string, string>;
  readonly definitionSource: string;
  readonly paragraphs: RangeSet<Paragraph>;
};

class Paragraph extends RangeValue {
  override startSide = -1;
  override endSide = 1;
}
const paragraph = new Paragraph();
const documents = new WeakMap<Text, MarkdownDocument>();

function wikiMatches(source: string, pattern: RegExp, omitEmbeds: boolean): WikiMatch[] {
  const matches: WikiMatch[] = [];
  for (const match of source.matchAll(pattern)) {
    const from = match.index;
    if (omitEmbeds && source[from - 1] === '!') continue;
    let slash = from;
    while (slash > 0 && source[slash - 1] === '\\') slash--;
    const value = match[1];
    if (value && (from - slash) % 2 === 0) matches.push({ from, to: from + match[0].length, value });
  }
  return matches;
}

function collectSpans(tree: Root, source: string): MarkdownSpans {
  const nodes: MarkdownNode[] = [];
  const visit = (node: Root | RootContent) => {
    switch (node.type) {
      case 'code': case 'inlineCode': case 'html': case 'definition':
      case 'image': case 'imageReference': case 'link': case 'linkReference': {
        const from = node.position?.start.offset;
        const to = node.position?.end.offset;
        if (from !== undefined && to !== undefined) nodes.push({ node, from, to, offset: 0 });
        break;
      }
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  return {
    nodes,
    wikiLinks: wikiMatches(source, /\[\[([^\]\r\n]+)\]\]/g, true),
    wikiEmbeds: wikiMatches(source, /!\[\[([^\]\r\n]+)\]\]/g, false)
  };
}

// Буква в начале строки исключает маркеры блоков, отступ и определения ссылок.
const paragraphStart = /^\p{L}/u;
const blank = /^[ \t]*$/;

function readMarkdown(source: string, doc?: Text): MarkdownDocument {
  const tree = fromMarkdown(source);
  const spans = collectSpans(tree, source);
  const definitions = new Map<string, string>();
  const definitionLines: string[] = [];
  for (const { node, from, to } of spans.nodes) {
    if (node.type !== 'definition') continue;
    definitions.set(node.identifier.toUpperCase(), node.url);
    definitionLines.push(source.slice(from, to));
  }
  const paragraphs: Range<Paragraph>[] = [];
  if (doc) for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type !== 'paragraph' || start === undefined || end === undefined) continue;
    const line = doc.lineAt(start);
    if (start === line.from && end <= line.to && paragraphStart.test(line.text) && !line.text.includes('\r') &&
      (line.number === 1 || blank.test(doc.line(line.number - 1).text)) &&
      (line.number === doc.lines || blank.test(doc.line(line.number + 1).text))) {
      paragraphs.push(paragraph.range(line.from, line.to));
    }
  }
  return {
    ...spans, slice: doc ? (from, to) => doc.sliceString(from, to) : (from, to) => source.slice(from, to),
    definitions, definitionSource: definitionLines.join('\n'), paragraphs: RangeSet.of(paragraphs)
  };
}

function replaceSpans<T extends SourceRange>(
  spans: readonly T[], local: readonly T[], from: number, to: number, delta: number,
  shift: (span: T, offset: number) => T
): readonly T[] {
  if (!spans.length && !local.length) return spans;
  const result: T[] = [];
  let index = 0;
  for (const span of spans) {
    if (span.from >= from) break;
    result.push(span);
    index++;
  }
  for (const span of local) result.push(shift(span, from));
  for (; index < spans.length; index++) {
    const span = spans[index];
    if (span && span.from >= to) result.push(shift(span, delta));
  }
  return result;
}

function reparseParagraph(transaction: Transaction, previous: MarkdownDocument): MarkdownDocument | undefined {
  let start = transaction.startState.doc.length;
  let end = 0;
  transaction.changes.iterChangedRanges((from, to) => {
    start = Math.min(start, from);
    end = Math.max(end, to);
  });
  let range: SourceRange | undefined;
  previous.paragraphs.between(start, start, (from, to) => {
    if (from <= start && end <= to) range = { from, to };
  });
  if (!range) return;
  const { from, to } = range;
  const doc = transaction.newDoc;
  const delta = doc.length - transaction.startState.doc.length;
  const source = doc.sliceString(from, to + delta);
  // Ссылки могут зависеть от определений за пределами абзаца.
  if (!paragraphStart.test(source) || /[\r\n]/.test(source) ||
    (previous.definitions.size && source.includes('['))) return;
  const local = collectSpans(fromMarkdown(source), source);
  const shiftWiki = (span: WikiMatch, offset: number) =>
    offset ? { ...span, from: span.from + offset, to: span.to + offset } : span;
  return {
    ...previous,
    slice: (start, end) => doc.sliceString(start, end),
    paragraphs: previous.paragraphs.map(transaction.changes),
    nodes: replaceSpans(previous.nodes, local.nodes, from, to, delta, (span, offset) =>
      offset ? { ...span, from: span.from + offset, to: span.to + offset, offset: span.offset + offset } : span),
    wikiLinks: replaceSpans(previous.wikiLinks, local.wikiLinks, from, to, delta, shiftWiki),
    wikiEmbeds: replaceSpans(previous.wikiEmbeds, local.wikiEmbeds, from, to, delta, shiftWiki)
  };
}

export function reuseMarkdownDocument(transaction: Transaction): void {
  if (!transaction.docChanged || documents.has(transaction.newDoc)) return;
  const previous = documents.get(transaction.startState.doc);
  if (!previous) return;
  const updated = reparseParagraph(transaction, previous);
  if (updated) documents.set(transaction.newDoc, updated);
}

export function markdownDocument(doc: Text | string): MarkdownDocument {
  if (typeof doc === 'string') return readMarkdown(doc);
  const cached = documents.get(doc);
  if (cached) return cached;
  const document = readMarkdown(doc.toString(), doc);
  documents.set(doc, document);
  return document;
}
