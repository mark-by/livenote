import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Node, Pair } from 'yaml';

export type EditableValue = string | number | boolean | readonly string[];
export type Property = {
  readonly name: string;
  readonly value: EditableValue | { readonly yaml: string };
  readonly editable: boolean;
  readonly removable: boolean;
};
export type PropertyEdit =
  | { readonly kind: 'add' | 'set'; readonly name: string; readonly value: EditableValue }
  | { readonly kind: 'rename'; readonly name: string; readonly next: string }
  | { readonly kind: 'remove'; readonly name: string };
type Change = { readonly from: number; readonly to: number; readonly insert: string };
type Entry = Property & {
  readonly range: readonly [number, number];
  readonly key: readonly [number, number];
  readonly valueRange: readonly [number, number];
};
type Empty = { readonly kind: 'missing' | 'invalid'; readonly rows: readonly []; readonly source: string };
type Valid = {
  readonly kind: 'valid';
  readonly rows: readonly Entry[];
  readonly source: string;
  readonly raw: string;
  readonly from: number;
  readonly close: number;
  readonly end: number;
  readonly canAdd: boolean;
  readonly indent: string;
  readonly newline: string;
};
export type Properties = Empty | Valid;

const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/;
const closing = /^---[ \t]*\r?$/m;

function afterLine(raw: string, end: number): number {
  if (end > 0 && raw[end - 1] === '\n') return end;
  const newline = raw.indexOf('\n', end);
  return newline < 0 ? raw.length : newline + 1;
}

function editableValue(name: string, node: Node): EditableValue | undefined {
  if (node.tag || ('anchor' in node && node.anchor)) return undefined;
  if (name === 'tags') {
    if (!isSeq(node)) return undefined;
    const tags: string[] = [];
    for (const item of node.items) {
      if (!isScalar(item) || item.tag || item.anchor || typeof item.value !== 'string') return undefined;
      tags.push(item.value);
    }
    return tags;
  }
  if (!isScalar(node)) return undefined;
  const value: unknown = node.value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || (typeof value === 'string' && !/[\r\n]/.test(value) &&
    node.type !== 'BLOCK_LITERAL' && node.type !== 'BLOCK_FOLDED')) return value;
  return undefined;
}

function entry(raw: string, pair: Pair<Node, Node | null>, block: boolean): Entry | undefined {
  const { key, value } = pair;
  if (!isScalar(key) || !key.range || typeof key.value !== 'string') return undefined;
  const colon = pair.srcToken?.sep?.find(token => token.type === 'map-value-ind');
  const [start, keyEnd] = key.range;
  const end = value?.range?.[1] ?? keyEnd;
  const valueStart = value?.range?.[0] ?? end;
  const lineStart = raw.lastIndexOf('\n', start - 1) + 1;
  const contentStart = colon ? colon.offset + 1 : valueStart;
  const supported = value ? editableValue(key.value, value) : undefined;
  const simpleKey = block && colon !== undefined &&
    !key.tag && !key.anchor && key.value.trim() === key.value && Boolean(key.value) &&
    /^[ \t]*$/.test(raw.slice(lineStart, start)) && /^[ \t]*$/.test(raw.slice(keyEnd, colon?.offset));
  const editable = simpleKey && supported !== undefined;
  const plainNull = isScalar(value) && value.value === null && !value.tag && !value.anchor;
  return {
    name: key.value,
    value: supported ?? { yaml: raw.slice(contentStart, end).trim() || 'null' },
    editable,
    removable: simpleKey && (editable || plainNull),
    range: [lineStart, afterLine(raw, end)],
    key: [start, keyEnd],
    valueRange: [valueStart, end],
  };
}

export function readProperties(source: string): Properties {
  const open = opening.exec(source)?.[0];
  if (!open) return { kind: 'missing', rows: [], source };
  const close = closing.exec(source.slice(open.length));
  if (!close) {
    const kind = /^[ \t]*(?:[^#\s][^\r\n]*?:|#.*\r?\n[ \t]*[^#\s][^\r\n]*?:)/.test(source.slice(open.length))
      ? 'invalid' : 'missing';
    return { kind, rows: [], source };
  }
  const closeOffset = open.length + close.index;
  const raw = source.slice(open.length, closeOffset);
  const doc = parseDocument(raw, { schema: 'core', resolveKnownTags: false, keepSourceTokens: true });
  if (doc.errors.length || (doc.contents && !isMap(doc.contents))) return { kind: 'invalid', rows: [], source };
  const root = doc.contents;
  const block = !root || (root.srcToken?.type === 'block-map' && !root.tag && !root.anchor);
  const rows = (root?.items ?? []).flatMap(pair => entry(raw, pair, block) ?? []);
  return {
    kind: 'valid', rows, raw, source, from: open.length, close: closeOffset,
    end: closeOffset + close[0].length,
    canAdd: block,
    indent: root?.range ? raw.slice(raw.lastIndexOf('\n', root.range[0] - 1) + 1, root.range[0]) : '',
    newline: open.endsWith('\r\n') ? '\r\n' : '\n',
  };
}

function encodeKey(name: string): string {
  return /^[a-zA-Z_][\w.-]*$/.test(name) && !/^(true|false|null)$/i.test(name) ? name : JSON.stringify(name);
}

function encodeValue(value: EditableValue): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0.0' : String(value);
  return JSON.stringify(value);
}

function validValue(name: string, value: EditableValue): boolean {
  if (typeof value === 'object') return name === 'tags';
  if (name === 'tags') return false;
  return typeof value === 'number' ? Number.isFinite(value) : true;
}

function append(properties: Properties, name: string, value: EditableValue): Change | null {
  if (!name || properties.rows.some(row => row.name === name) || !validValue(name, value)) return null;
  const line = `${encodeKey(name)}: ${encodeValue(value)}`;
  if (properties.kind === 'valid') {
    return properties.canAdd
      ? { from: properties.close, to: properties.close, insert: properties.indent + line + properties.newline }
      : null;
  }
  const source = properties.source;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const from = source.startsWith('\uFEFF') ? 1 : 0;
  return { from, to: from, insert: ['---', line, '---', '', ''].slice(0, source.length > from ? 5 : 4).join(newline) };
}

export function editProperty(properties: Properties, edit: PropertyEdit): Change | null {
  if (properties.kind === 'invalid') return null;
  if (edit.kind === 'add') return append(properties, edit.name.trim(), edit.value);
  if (properties.kind !== 'valid') return null;
  const row = properties.rows.find(item => item.name === edit.name);
  if (!row || !(edit.kind === 'remove' ? row.removable : row.editable)) return null;
  const patch = ([from, to]: readonly [number, number], insert: string): Change =>
    ({ from: properties.from + from, to: properties.from + to, insert });
  switch (edit.kind) {
    case 'remove':
      return patch(row.range, '');
    case 'rename': {
      const name = edit.next.trim();
      if (!name || row.name === 'tags' || name === 'tags' || properties.rows.some(item => item.name === name)) return null;
      return patch(row.key, encodeKey(name));
    }
    case 'set': {
      if (!validValue(row.name, edit.value) || Object.is(row.value, edit.value)) return null;
      const [from, to] = row.valueRange;
      const lineStart = properties.raw.lastIndexOf('\n', from - 1) + 1;
      const indent = lineStart === from ? properties.indent + '  ' : '';
      // Диапазон блочного списка включает последний перевод строки.
      const newline = properties.raw[to - 1] === '\n' ? properties.newline : '';
      return patch([from, to], indent + encodeValue(edit.value) + newline);
    }
  }
}
