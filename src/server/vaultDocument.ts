import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { isMap, isSeq, parseDocument } from 'yaml';
import type { BlockType, DiagramFormat, VaultAsset, VaultDocument, VaultProblem, VaultProblemCode } from '../shared/types.js';
import { destinationToken, markdownProse } from './vaultMarkdown.js';
export { destinationToken, markdownProse } from './vaultMarkdown.js';

export class DocumentProblem extends Error {
  constructor(public code: VaultProblemCode, message: string, public pageId?: string, public blockId?: string) { super(message); }
}

export interface BlockSpan {
  id: string; type: BlockType; start: number; contentStart: number; contentEnd: number; end: number;
  assetPath?: string; destinationStart?: number; destinationEnd?: number; title?: string | null;
}
export interface ParsedVaultDocument {
  document: VaultDocument; spans: BlockSpan[]; bodyStart: number; newline: string; problems: VaultProblem[]; prose: string;
}
export type VaultSyntax = {
  readonly spans: BlockSpan[];
  readonly problems: VaultProblem[];
  readonly aliases: string[];
  readonly tags: string[];
  readonly prose: string;
};
export function hasGitConflict(source: string): boolean {
  return /^<<<<<<<[^\r\n]*\r?$\n[\s\S]*?^=======[ \t]*\r?$\n[\s\S]*?^>>>>>>>[^\r\n]*$/m.test(source);
}
export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function fileVersion(source: string | Buffer): string { return 'sha256:' + sha256(source); }
export function diagramFormat(path: string): DiagramFormat | undefined {
  switch (posix.extname(path).toLowerCase()) {
    case '.mmd': case '.mermaid': return 'mermaid';
    case '.bpmn': return 'bpmn';
    case '.drawio': return 'drawio';
    default: return undefined;
  }
}
export function openable(path: string): boolean { return path.endsWith('.md') || diagramFormat(path) !== undefined; }
export function fingerprint(path: string, source: string, assets: VaultAsset[]): { version: string; revision: number } {
  const hash = createHash('sha256');
  const field = (value: string): void => {
    const bytes = Buffer.from(value); const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length).update(bytes);
  };
  field('livenote-vault-v2'); field(path); field(source);
  const unique = [...new Map(assets.map(asset => [asset.path, asset])).values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  field(String(unique.length));
  for (const asset of unique) { field(asset.path); field(asset.type); field(asset.source === null ? 'missing' : 'present'); field(asset.source ?? ''); }
  const digest = hash.digest('hex');
  return { version: 'sha256:' + digest, revision: 1 + Number.parseInt(digest.slice(0, 13), 16) };
}
export function applyEdits(source: string, edits: Array<{ start: number; end: number; value: string }>): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.value + text.slice(edit.end), source);
}
export function assetDestination(notePath: string, destination: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(destination); } catch { throw new DocumentProblem('unsafe_path', 'Некорректное кодирование пути'); }
  if (/[\0\\]/.test(decoded) || /^(?:\/|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(decoded)) throw new DocumentProblem('unsafe_path', 'Небезопасный путь диаграммы');
  const path = posix.normalize(posix.join(posix.dirname(notePath), decoded.split('#')[0] ?? decoded));
  if (path === '..' || path.startsWith('../') || path.split('/').some(part => ['.git', '.livenote'].includes(part))) throw new DocumentProblem('unsafe_path', 'Путь выходит за пределы vault');
  return path;
}
function metadata(source: string): { aliases: string[]; tags: string[] } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source);
  if (match?.index !== 0) return { aliases: [], tags: [] };
  const doc = parseDocument(match[1] ?? '', { schema: 'core', resolveKnownTags: false });
  const strings = (key: string): string[] => {
    if (!isMap(doc.contents) || doc.errors.length) return [];
    const node = doc.get(key, true);
    const value: unknown = isSeq(node) ? node.toJSON() : node;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  };
  return { aliases: strings('aliases'), tags: strings('tags') };
}
/** Только диапазоны исходной строки; AST никогда не сериализуется обратно. */
export function parseVaultDocument(source: string, path: string, loadAsset: (path: string) => { source: string; mtimeMs?: number }, stat = { birthtimeMs: 0, mtimeMs: 0 }): ParsedVaultDocument {
  return materializeVaultDocument(source, path, parseVaultSyntax(source, path), loadAsset, stat);
}

export function parseVaultSyntax(source: string, path: string): VaultSyntax {
  if (hasGitConflict(source)) throw new DocumentProblem('git_conflict', 'Обнаружен конфликт Git', path);
  const spans: BlockSpan[] = [];
  const problems: VaultProblem[] = [];
  const format = diagramFormat(path);
  const root = fromMarkdown(source);
  const bom = source.startsWith('\uFEFF') ? 1 : 0;
  const excluded: Array<{ from: number; to: number }> = [];
  const definitions = new Map<string, { url: string; start: number; end: number }>();
  const candidates: BlockSpan[] = [];
  const addEmbed = (start: number, end: number, target: string, label: string | null, destination?: { start: number; end: number }): void => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return;
    let assetPath: string;
    try { assetPath = assetDestination(path, target); }
    catch (error) { if (!(error instanceof DocumentProblem)) throw error; problems.push({ code: error.code, path, message: error.message, pageId: path }); return; }
    const type = diagramFormat(assetPath);
    if (!type) return;
    candidates.push({ id: '', type, start, end, contentStart: start, contentEnd: end, assetPath, title: label,
      ...(destination ? { destinationStart: destination.start, destinationEnd: destination.end } : {}) });
  };
  const walk = (node: typeof root | (typeof root.children)[number]): void => {
    const start = node.position?.start.offset === undefined ? undefined : node.position.start.offset + bom;
    const end = node.position?.end.offset === undefined ? undefined : node.position.end.offset + bom;
    if (start === undefined || end === undefined) return;
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') {
      excluded.push({ from: start, to: end });
      if (node.type === 'code' && node.lang === 'mermaid') {
        const raw = source.slice(start, end);
        const opening = /^ {0,3}(`{3,}|~{3,})mermaid[^\r\n]*(?:\r?\n)/.exec(raw);
        if (opening) {
          const closing = new RegExp('^ {0,3}' + (opening[1]?.[0] ?? '`') + '{' + (opening[1]?.length ?? 3) + ',}[ \\t]*$', 'm');
          const rest = raw.slice(opening[0].length); const close = closing.exec(rest);
          const contentEnd = close ? start + opening[0].length + close.index - (rest.slice(0, close.index).endsWith('\r\n') ? 2 : rest.slice(0, close.index).endsWith('\n') ? 1 : 0) : end;
          candidates.push({ id: '', type: 'mermaid', start, end, contentStart: start + opening[0].length, contentEnd });
        }
      }
      return;
    }
    if (node.type === 'definition') {
      const token = destinationToken(source.slice(start, end), true);
      if (token) definitions.set(node.identifier, { url: node.url, start: start + token.start, end: start + token.end });
    }
    if ('children' in node) for (const child of node.children) walk(child);
  };
  walk(root);
  const images = (node: typeof root | (typeof root.children)[number]): void => {
    const start = node.position?.start.offset === undefined ? undefined : node.position.start.offset + bom;
    const end = node.position?.end.offset === undefined ? undefined : node.position.end.offset + bom;
    if (start === undefined || end === undefined) return;
    if (node.type === 'image') {
      const token = destinationToken(source.slice(start, end));
      addEmbed(start, end, node.url, node.alt ?? null, token ? { start: start + token.start, end: start + token.end } : undefined);
    }
    if (node.type === 'imageReference') {
      const definition = definitions.get(node.identifier);
      if (definition) addEmbed(start, end, definition.url, node.alt ?? null, definition);
    }
    if ('children' in node) for (const child of node.children) images(child);
  };
  images(root);
  for (const match of source.matchAll(/!\[\[([^\]\r\n]+)\]\]/g)) {
    const start = match.index;
    let slashes = 0; for (let at = start - 1; source[at] === '\\'; at--) slashes++;
    if (slashes % 2 || excluded.some(range => start >= range.from && start < range.to)) continue;
    const inner = match[1] ?? ''; const pipe = inner.indexOf('|'); const target = pipe < 0 ? inner : inner.slice(0, pipe);
    addEmbed(start, start + match[0].length, target, pipe < 0 ? null : inner.slice(pipe + 1), { start: start + 3, end: start + 3 + target.length });
  }
  if (format) spans.push({ id: '', type: format, start: 0, end: source.length, contentStart: 0, contentEnd: source.length });
  else {
    let cursor = 0;
    for (const span of candidates.sort((a, b) => a.start - b.start)) {
      if (span.start < cursor) continue;
      if (cursor < span.start) spans.push({ id: '', type: 'markdown', start: cursor, contentStart: cursor, contentEnd: span.start, end: span.start });
      spans.push(span); cursor = span.end;
    }
    if (cursor < source.length) spans.push({ id: '', type: 'markdown', start: cursor, contentStart: cursor, contentEnd: source.length, end: source.length });
  }
  for (const [position, span] of spans.entries()) span.id = 'span-' + position;
  const data = metadata(source);
  const prose = markdownProse(source);
  const tags = [...new Set([...data.tags, ...[...prose.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu)].map(match => match[1] ?? '')])];
  return { spans, problems, aliases: data.aliases, tags, prose };
}

export function materializeVaultDocument(source: string, path: string, syntax: VaultSyntax, loadAsset: (path: string) => { source: string; mtimeMs?: number; version?: string }, stat: { readonly birthtimeMs: number; readonly mtimeMs: number }): ParsedVaultDocument {
  const { spans, aliases, tags, prose } = syntax;
  const problems = [...syntax.problems];
  const assets = new Map<string, VaultAsset>();
  let latest = stat.mtimeMs;
  const createdAt = new Date(stat.birthtimeMs || stat.mtimeMs || 0).toISOString();
  const blocks = spans.map((span, position) => {
    let content = source.slice(span.contentStart, span.contentEnd);
    if (span.assetPath) {
      let asset = assets.get(span.assetPath);
      if (!asset) {
        let loaded: ReturnType<typeof loadAsset> | null = null;
        try { loaded = loadAsset(span.assetPath); } catch (error) {
          const code = error instanceof DocumentProblem ? error.code : 'missing_asset';
          problems.push({ code, path: span.assetPath, pageId: path, blockId: span.id, message: 'Файл диаграммы недоступен' });
        }
        asset = { path: span.assetPath, type: span.type === 'markdown' ? 'mermaid' : span.type, source: loaded?.source ?? null, version: loaded ? (loaded.version ?? fileVersion(loaded.source)) : null };
        latest = Math.max(latest, loaded?.mtimeMs ?? 0); assets.set(span.assetPath, asset);
      }
      content = asset.source ?? '';
    }
    return { id: span.id, pageId: path, type: span.type, source: content, title: span.title ?? null, position, createdAt, updatedAt: '', renderedRevision: null, renderOk: null, renderError: null };
  });
  const updatedAt = new Date(latest).toISOString();
  for (const block of blocks) block.updatedAt = updatedAt;
  const tokens = fingerprint(path, source, [...assets.values()]);
  return { document: { page: { id: path, title: posix.basename(path, posix.extname(path)), revision: tokens.revision, createdAt, updatedAt, blocks }, path, source, version: tokens.version,
    spans: spans.map(span => ({ blockId: span.id, type: span.type, from: span.start, to: span.end, sourceFrom: span.contentStart, sourceTo: span.contentEnd, ...(span.assetPath ? { assetPath: span.assetPath } : {}) })),
    aliases: [...aliases], tags: [...tags], assets: [...assets.values()], links: [], backlinks: [] }, spans, bodyStart: 0, newline: source.includes('\r\n') ? '\r\n' : '\n', problems, prose };
}
export function blockContent(type: BlockType, source: string, newline: string, assetUrl?: string, title?: string | null): string {
  switch (type) {
    case 'markdown': return source;
    case 'mermaid': {
      const fence = '`'.repeat(Math.max(3, ...[...source.matchAll(/`+/g)].map(match => match[0].length + 1)));
      return `${fence}mermaid${newline}${source}${newline}${fence}`;
    }
    case 'bpmn': case 'drawio': return `![${(title ?? type).replace(/[\[\]\\]/g, '\\$&')}](${assetUrl})`;
  }
}
export function safeTitle(title: string): string {
  return title.normalize('NFC').replace(/[\\/:*?"<>|\0]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'Заметка';
}
export function relativeUrl(from: string, to: string, style?: { kind: 'wiki' | 'markdown'; original: string; angled?: boolean }): string {
  const encoded = [...(style?.original.split('#')[0] ?? '').matchAll(/(?:%[a-f0-9]{2})+/gi)].flatMap(match => {
    try { return [...decodeURIComponent(match[0])]; } catch { return []; }
  });
  const encodedUnicode = encoded.some(char => /[^\x00-\x7f]/.test(char));
  const path = posix.relative(posix.dirname(from), to) || posix.basename(to);
  const escaped = [...path].map(char => {
    if (char === '/') return char;
    const unsafe = style?.kind === 'wiki' ? /[%#?|[\]\\\x00-\x1f\x7f]/.test(char)
      : style?.angled ? /[%#?<>\x00-\x1f\x7f]/.test(char) : /[%#?()[\]<>"'`\\\s\x7f]/.test(char);
    if (style?.kind === 'markdown' && style.original.includes('\\' + char) && /[()[\]<>\\]/.test(char)) return '\\' + char;
    return unsafe || encoded.includes(char) || (encodedUnicode && /[^\x00-\x7f]/.test(char))
      ? encodeURIComponent(char).replace(/[!'()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase()) : char;
  }).join('');
  return style?.original.startsWith('./') && !escaped.startsWith('../') ? './' + escaped : escaped;
}
