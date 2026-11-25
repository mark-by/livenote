import type { DiagramFormat, VaultDocument, VaultLink } from '../../shared/types';

export interface VaultFileEntry {
  readonly path: string;
  readonly kind: 'markdown' | DiagramFormat;
  readonly title: string;
  readonly version: string;
  readonly revision: number;
}

export const DIAGRAM_EXTENSIONS = {
  mermaid: ['.mmd', '.mermaid'],
  bpmn: ['.bpmn'],
  drawio: ['.drawio']
} as const;

export function parentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function fileStem(path: string): string {
  return fileName(path).replace(/\.[^.]+$/, '');
}

export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

export function formatForPath(path: string): 'markdown' | DiagramFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) return 'markdown';
  if (DIAGRAM_EXTENSIONS.mermaid.some((extension) => lower.endsWith(extension))) return 'mermaid';
  if (lower.endsWith('.bpmn')) return 'bpmn';
  if (lower.endsWith('.drawio')) return 'drawio';
  return null;
}

export function resolveVaultPath(documentPath: string, target: string): string | null {
  if (!target || target.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/|\\)/i.test(target)) return null;
  const withoutFragment = target.split('#')[0] ?? '';
  if (!withoutFragment) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(withoutFragment); } catch { return null; }
  const parts = decoded.startsWith('/') ? [] : parentPath(documentPath).split('/').filter(Boolean);
  for (const part of decoded.replace(/^\.\//, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

export function relativeVaultPath(fromDocument: string, target: string): string {
  const from = parentPath(fromDocument).split('/').filter(Boolean);
  const to = target.split('/').filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const prefix = from.slice(shared).map(() => '..');
  const suffix = to.slice(shared);
  const value = [...prefix, ...suffix].join('/');
  return value.startsWith('.') ? value : `./${value}`;
}

export function nextAssetPath(documentPath: string, format: DiagramFormat, existing: readonly string[]): string {
  const extension = format === 'mermaid' ? '.mmd' : `.${format}`;
  const role = format === 'bpmn' ? 'Процесс' : format === 'drawio' ? 'Диаграмма' : 'Схема';
  const occupied = new Set(existing);
  for (let index = 1; ; index++) {
    const suffix = index === 1 ? '' : ` ${index}`;
    const candidate = `Схемы/${fileStem(documentPath)} — ${role}${suffix}${extension}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

export function mermaidFence(source: string): string {
  const longest = Math.max(2, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}mermaid\n${source.replace(/\n$/, '')}\n${fence}`;
}

function blockInsertionPosition(source: string, position: number): number {
  const bounded = Math.max(0, Math.min(source.length, position));
  const lineEndIndex = source.indexOf('\n', bounded);
  const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
  if (bounded === lineEnd) return bounded;
  const lineStart = source.lastIndexOf('\n', bounded) + 1;
  return source.slice(lineStart, lineEnd).trim() ? lineStart : bounded;
}

export function insertBlockAt(source: string, position: number, block: string): {
  source: string;
  from: number;
  to: number;
  edit: { from: number; to: number; text: string };
} {
  const from = blockInsertionPosition(source, position);
  const before = source.slice(0, from);
  const after = source.slice(from);
  const prefix = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const suffix = after.length === 0 ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const inserted = `${prefix}${block}${suffix}`;
  return {
    source: `${before}${inserted}${after}`,
    from: before.length + prefix.length,
    to: before.length + inserted.length - suffix.length,
    edit: { from, to: from, text: inserted }
  };
}

export function appendInlineTag(source: string, tag: string): string {
  const clean = tag.trim().replace(/^#+/, '').replace(/\s+/g, '-');
  if (!clean) return source;
  const separator = source.length === 0 ? '' : source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return `${source}${separator}#${clean}\n`;
}

export function resolveDocumentLink(document: VaultDocument, target: string): VaultLink | null {
  const direct = document.links.find((link) => link.target === target && link.targetPageId !== null);
  if (direct) return direct;
  const path = resolveVaultPath(document.path, target);
  if (path === null) return null;
  return document.links.find((link) => link.targetPageId === path) ?? null;
}

export function resolveDiagramAsset(document: VaultDocument, diagram: { readonly from: number; readonly to: number; readonly target?: string }) {
  const path = diagram.target
    ? resolveVaultPath(document.path, diagram.target)
    : document.spans.find((span) => span.from === diagram.from && span.to === diagram.to)?.assetPath;
  return path ? document.assets.find((asset) => asset.path === path) : undefined;
}

export function remapPath(path: string, moved: readonly { from: string; to: string }[]): string {
  const exact = moved.find((entry) => entry.from === path);
  if (exact) return exact.to;
  const parent = moved
    .filter((entry) => path.startsWith(`${entry.from}/`))
    .sort((a, b) => b.from.length - a.from.length)[0];
  return parent ? `${parent.to}${path.slice(parent.from.length)}` : path;
}
