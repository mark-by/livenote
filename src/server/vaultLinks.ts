import { posix } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { VaultBacklink, VaultDocument, VaultLink } from '../shared/types.js';
import { applyEdits, assetDestination, destinationToken, relativeUrl } from './vaultDocument.js';

export interface LinkSpan extends VaultLink { start: number; end: number; fullStart: number; fullEnd: number }
export function folded(value: string): string { return value.normalize('NFC').toLocaleLowerCase().replace(/ς/g, 'σ'); }
function targetParts(value: string): { target: string; fragment: string | null } {
  const at = value.indexOf('#');
  return { target: at < 0 ? value : value.slice(0, at), fragment: at < 0 ? null : value.slice(at + 1) };
}
export function linkSpans(source: string, bodyStart = 0): LinkSpan[] {
  const bom = source.slice(bodyStart).startsWith('\uFEFF') ? 1 : 0;
  const text = source.slice(bodyStart + bom); const root = fromMarkdown(text); const links: LinkSpan[] = [];
  const offset = bodyStart + bom;
  const excluded: Array<[number, number]> = []; const definitions = new Map<string, (typeof root.children)[number]>(); const references = new Set<string>();
  const add = (node: (typeof root.children)[number]): void => {
    if (!('url' in node) || !node.position) return;
    const start = node.position.start.offset; const end = node.position.end.offset;
    if (start === undefined || end === undefined || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(node.url)) return;
    const token = destinationToken(text.slice(start, end), node.type === 'definition');
    if (!token) return;
    links.push({ ...targetParts(node.url), targetPageId: null, label: null, kind: 'markdown', start: offset + start + token.start, end: offset + start + token.end, fullStart: offset + start, fullEnd: offset + end });
  };
  const walk = (node: typeof root | (typeof root.children)[number]): void => {
    const start = node.position?.start.offset; const end = node.position?.end.offset;
    if (['code', 'inlineCode', 'html'].includes(node.type) && start !== undefined && end !== undefined) { excluded.push([start, end]); return; }
    if (node.type === 'definition') definitions.set(node.identifier, node);
    if (node.type === 'link' || node.type === 'image') add(node);
    if (node.type === 'linkReference' || node.type === 'imageReference') references.add(node.identifier);
    if ('children' in node) for (const child of node.children) walk(child);
  };
  walk(root);
  for (const id of references) { const definition = definitions.get(id); if (definition) add(definition); }
  for (const match of text.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
    const at = match.index;
    let slashes = 0; for (let i = at - (text[at - 1] === '!' ? 2 : 1); text[i] === '\\'; i--) slashes++;
    if (slashes % 2 || excluded.some(([a, b]) => at >= a && at < b)) continue;
    const inner = match[1] ?? ''; const pipe = inner.indexOf('|'); const target = pipe < 0 ? inner : inner.slice(0, pipe);
    links.push({ ...targetParts(target), targetPageId: null, label: pipe < 0 ? null : inner.slice(pipe + 1), kind: 'wiki',
      start: offset + at + 2, end: offset + at + 2 + target.length, fullStart: offset + at, fullEnd: offset + at + match[0].length });
  }
  return links.sort((a, b) => a.start - b.start);
}
export function resolveLinks(document: VaultDocument, pages: VaultDocument[], bodyStart = 0, paths = pages.map(page => page.path)): LinkSpan[] {
  return linkResolver(pages, paths)(document.path, linkSpans(document.source, bodyStart));
}

function linkResolver(pages: readonly VaultDocument[], paths: readonly string[]) {
  const files = new Set(paths);
  const names = new Map<string, string | null>();
  for (const page of pages) for (const name of new Set([page.page.title, ...page.aliases].map(folded))) {
    names.set(name, names.has(name) ? null : page.path);
  }
  return (path: string, links: readonly LinkSpan[]): LinkSpan[] => links.map(link => {
    if (!link.target) return { ...link, targetPageId: path };
    let relative: string;
    try { relative = assetDestination(path, link.target); } catch { return { ...link }; }
    let root = relative;
    if (link.kind === 'wiki') {
      try { root = assetDestination('root.md', link.target); } catch { root = relative; }
    }
    const candidates = link.kind === 'wiki' && !posix.extname(relative) ? [relative + '.md', root + '.md'] : [relative];
    const targetPageId = candidates.find(candidate => files.has(candidate)) ??
      (link.kind === 'wiki' ? names.get(folded(link.target)) : null) ?? null;
    return { ...link, targetPageId };
  });
}

export function buildLinkGraph(pages: readonly VaultDocument[], paths: readonly string[], spans: ReadonlyMap<string, readonly LinkSpan[]>) {
  const resolve = linkResolver(pages, paths);
  const links = new Map<string, LinkSpan[]>();
  const backlinks = new Map<string, VaultBacklink[]>();
  const documents = new Set(pages.map(page => page.path));
  for (const page of pages) {
    const resolved = resolve(page.path, spans.get(page.path) ?? []);
    links.set(page.path, resolved);
    const targets = new Set(resolved.map(link => link.targetPageId));
    for (const target of targets) {
      if (!target || target === page.path || !documents.has(target)) continue;
      const incoming = backlinks.get(target) ?? [];
      incoming.push({ pageId: page.path, path: page.path, title: page.page.title });
      backlinks.set(target, incoming);
    }
  }
  for (const incoming of backlinks.values()) incoming.sort((a, b) => a.path.localeCompare(b.path));
  return { links, backlinks };
}
export function publicLinks(links: LinkSpan[]): VaultLink[] { return links.map(({ target, targetPageId, label, kind, fragment }) => ({ target, targetPageId, label, kind, fragment })); }
/** Одна таблица перемещений преобразует базы и назначения до записи. */
export function rewritePaths(document: VaultDocument, links: LinkSpan[], mapping: ReadonlyMap<string, string>): string {
  const from = mapping.get(document.path) ?? document.path;
  const edits: Array<{ start: number; end: number; value: string }> = [];
  for (const link of links) {
    if (!link.target || !link.targetPageId) continue;
    const to = mapping.get(link.targetPageId) ?? link.targetPageId;
    if (from === document.path && to === link.targetPageId) continue;
    const value = relativeUrl(from, to, { kind: link.kind, original: document.source.slice(link.start, link.end), angled: document.source[link.start - 1] === '<' }) + (link.fragment === null ? '' : '#' + link.fragment);
    edits.push({ start: link.start, end: link.end, value: link.kind === 'wiki' && link.label === null ? value + '|' + link.target : value });
  }
  return applyEdits(document.source, edits);
}
