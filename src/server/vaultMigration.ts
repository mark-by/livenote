import Database from 'better-sqlite3';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
import { z } from 'zod';
import { InvalidRequestError } from './errors.js';
import { blockContent, diagramFormat, fileVersion, parseVaultDocument, relativeUrl, safeTitle } from './vaultDocument.js';
import { VaultFiles, type FileWrite } from './vaultFiles.js';
import { linkSpans } from './vaultLinks.js';
import { legacyDocument } from './vaultMigrationLegacy.js';
import { applyEdits, assetDestination } from './vaultDocument.js';

const pageSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/), title: z.string(), created_at: z.string(), updated_at: z.string(), deleted_at: z.string().nullable() });
const blockSchema = z.object({ id: z.string(), type: z.enum(['markdown', 'mermaid', 'bpmn', 'drawio']), source: z.string(), title: z.string().nullable().optional(), created_at: z.string(), updated_at: z.string() });
interface MigrationResult { pages: number; deletedPages: number; warning: string }
interface NativeFile { path: string; source: Buffer | string }
const warning = 'Ревизии и временные block IDs изменились. Перечитайте документы; исходные данные сохранены в .livenote/migration.';

function destination(source: string, target: string): string {
  const absolute = resolve(target);
  const sourceReal = realpathSync(source);
  const parent = dirname(absolute);
  let ancestor = parent;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, absolute));
  const inside = relative(sourceReal, actual);
  if (inside === '' || (!inside.startsWith('..') && !inside.startsWith('/'))) throw new InvalidRequestError('Назначение не может находиться внутри источника');
  if (existsSync(absolute) && (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory() || readdirSync(absolute).length)) throw new InvalidRequestError('Назначение должно отсутствовать или быть пустым каталогом');
  mkdirSync(parent, { recursive: true });
  return absolute;
}
function unique(path: string, used: Set<string>): string {
  const dot = path.lastIndexOf('.'); let result = path; let n = 2;
  while (used.has(result.normalize('NFC').toLowerCase())) result = path.slice(0, dot) + ' ' + n++ + path.slice(dot);
  used.add(result.normalize('NFC').toLowerCase()); return result;
}
function publish(staged: string, target: string): void {
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || readdirSync(target).length) throw new InvalidRequestError('Назначение изменилось');
    rmdirSync(target);
  }
  renameSync(staged, target);
}
function writeMigration(staged: string, files: NativeFile[], archive: NativeFile[], manifest: unknown, folders: string[] = []): void {
  const store = new VaultFiles(staged);
  try {
    const writes: FileWrite[] = [...files, ...archive.map(file => ({ ...file, path: '.livenote/migration/' + file.path })),
      { path: '.livenote/migration/manifest.json', source: JSON.stringify(manifest, null, 2) }].map(file => ({ ...file, expected: null }));
    store.commit(writes, folders.filter(Boolean).map(path => ({ path, old: false, next: true })));
    for (const file of [...files, ...archive.map(file => ({ ...file, path: '.livenote/migration/' + file.path }))]) {
      if (!store.readBytes(file.path).bytes.equals(Buffer.from(file.source))) throw new InvalidRequestError('Байты миграции не совпали', { path: file.path });
    }
    for (const file of files.filter(file => file.path.endsWith('.md') && !file.path.startsWith('.livenote/'))) {
      const parsed = parseVaultDocument(store.read(file.path).source, file.path, path => store.read(path));
      if (parsed.problems.length) throw new InvalidRequestError('Не удалось проверить ссылки диаграмм', parsed.problems);
    }
  } finally { store.close(); }
}
function unchanged(paths: string[], originals: Map<string, Buffer | null>): void {
  for (const path of paths) {
    const before = originals.get(path); const after = existsSync(path) ? readFileSync(path) : null;
    if (before === undefined || (before === null ? after !== null : after === null || !before.equals(after))) throw new InvalidRequestError('Источник изменился во время миграции', { path });
  }
}
/** DB/WAL/SHM копируются до подключения SQLite; исходные файлы никогда не открываются SQLite. */
export function migrateVault(dbPath: string, targetPath: string): MigrationResult {
  if (lstatSync(dbPath).isSymbolicLink()) throw new InvalidRequestError('Источник не может быть symlink');
  const target = destination(dbPath, targetPath);
  const sourcePaths = [resolve(dbPath), resolve(dbPath) + '-wal', resolve(dbPath) + '-shm'];
  for (const path of sourcePaths) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new InvalidRequestError('Файлы SQLite не могут быть symlink');
  const originals = new Map(sourcePaths.map(path => [path, existsSync(path) ? readFileSync(path) : null]));
  const staged = mkdtempSync(join(dirname(target), '.' + basename(target) + '-migration-'));
  let db: Database.Database | undefined;
  try {
    const copied = join(staged, '.livenote/migration/sqlite/source.sqlite');
    const temp = new VaultFiles(staged);
    try {
      temp.commit(sourcePaths.flatMap((path, i) => {
        const source = originals.get(path);
        return source ? [{ path: '.livenote/migration/sqlite/source.sqlite' + (i === 1 ? '-wal' : i === 2 ? '-shm' : ''), source, expected: null }] : [];
      }));
    } finally { temp.close(); }
    unchanged(sourcePaths, originals);
    db = new Database(copied, { readonly: true, fileMustExist: true, timeout: 5000 });
    const copyDb = db;
    const snapshot = copyDb.transaction(() => z.array(pageSchema).parse(copyDb.prepare('SELECT * FROM pages ORDER BY position, created_at').all()).map(page => ({
      page, blocks: z.array(blockSchema).parse(copyDb.prepare('SELECT * FROM blocks WHERE page_id = ? ORDER BY position, created_at').all(page.id))
    }))).deferred();
    const files: NativeFile[] = []; const used = new Set<string>(); const mapping = new Map<string, string>();
    for (const { page } of snapshot) mapping.set(page.id, unique(safeTitle(page.title) + '.md', used));
    let pages = 0; let deletedPages = 0;
    const records: unknown[] = [];
    for (const { page, blocks } of snapshot) {
      const path = mapping.get(page.id);
      if (!path) throw new InvalidRequestError('Отсутствует путь миграции');
      const prefix = page.deleted_at ? '.livenote/trash/migration/' : ''; const parts: string[] = [];
      for (const [index, block] of blocks.entries()) {
        let assetPath: string | undefined;
        if (block.type === 'bpmn' || block.type === 'drawio') {
          assetPath = unique(`Схемы/${safeTitle(page.title)} — ${safeTitle(block.title || block.type + ' ' + (index + 1))}.${block.type}`, used);
          files.push({ path: prefix + assetPath, source: block.source });
        }
        let content = blockContent(block.type, block.source, '\n', assetPath ? relativeUrl(path, assetPath) : undefined, block.title);
        if (block.type === 'mermaid' && block.title) content = '## ' + block.title + '\n' + content;
        parts.push(content);
      }
      let source = parts.join('\n\n');
      source = rewriteMigrationLinks(source, path, mapping, new Map(), path);
      files.push({ path: prefix + path, source });
      records.push({ ...page, path: prefix + path, blocks });
      if (page.deleted_at) deletedPages++; else pages++;
    }
    const archive = sourcePaths.flatMap((path, i) => {
      const source = originals.get(path);
      return source ? [{ path: 'original/source.sqlite' + (i === 1 ? '-wal' : i === 2 ? '-shm' : ''), source }] : [];
    });
    archive.push({ path: 'blocks.json', source: Buffer.from(JSON.stringify(records, null, 2)) });
    writeMigration(staged, files, archive, { source: 'sqlite', records, checksums: files.map(file => ({ path: file.path, version: fileVersion(file.source) })) });
    db.close(); db = undefined;
    unchanged(sourcePaths, originals); publish(staged, target);
    return { pages, deletedPages, warning };
  } finally { db?.close(); if (existsSync(staged)) rmSync(staged, { recursive: true, force: true }); }
}
function rewriteMigrationLinks(source: string, oldPath: string, paths: ReadonlyMap<string, string>, ids: ReadonlyMap<string, string>, newPath: string): string {
  const edits = linkSpans(source).flatMap(link => {
    let target = ids.get(link.target) ?? paths.get(link.target);
    if (!target) {
      try {
        const relative = migrationDestination(oldPath, link.target);
        target = paths.get(relative) ?? paths.get(relative + '.md');
      } catch { return []; }
    }
    if (!target) return [];
    return [{ start: link.start, end: link.end, value: relativeUrl(newPath, target, { kind: link.kind, original: source.slice(link.start, link.end), angled: source[link.start - 1] === '<' }) + (link.fragment === null ? '' : '#' + link.fragment) }];
  });
  return applyEdits(source, edits);
}
function migrationDestination(from: string, target: string): string {
  const decoded = decodeURIComponent(target);
  if (/[\0\\]/.test(decoded) || /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(decoded)) throw new InvalidRequestError('Небезопасная ссылка legacy vault');
  const path = posix.normalize(posix.join(posix.dirname(from), decoded));
  if (path === '..' || path.startsWith('../')) throw new InvalidRequestError('Ссылка выходит за источник');
  return path;
}
/** Исходный vault читается без lock, recovery и записи. */
export function migrateFromVault(sourcePath: string, targetPath: string): MigrationResult {
  if (lstatSync(sourcePath).isSymbolicLink()) throw new InvalidRequestError('Источник не может быть symlink');
  const sourceRoot = realpathSync(sourcePath); const target = destination(sourceRoot, targetPath);
  const original = new Map<string, Buffer>(); const folders: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(join(sourceRoot, path), { withFileTypes: true })) {
      const child = path ? path + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new InvalidRequestError('Symlink запрещён при миграции', { path: child });
      if (child === '.livenote/transactions' && readdirSync(join(sourceRoot, child)).length) throw new InvalidRequestError('Сначала восстановите незавершённый журнал источника');
      if (entry.isDirectory()) { if (!child.startsWith('.livenote') && child !== '.git') folders.push(child); walk(child); }
      else if (entry.isFile()) original.set(child, readFileSync(join(sourceRoot, child)));
      else throw new InvalidRequestError('Поддерживаются только обычные файлы', { path: child });
    }
  };
  walk('');
  const staged = mkdtempSync(join(dirname(target), '.' + basename(target) + '-migration-'));
  try {
    const used = new Set<string>(); const mapping = new Map<string, string>(); const ids = new Map<string, string>(); const ambiguous = new Set<string>();
    const notes = new Map<string, ReturnType<typeof legacyDocument>>();
    for (const [path, bytes] of original) {
      if (!path.endsWith('.md') || path.startsWith('.livenote/') || path.startsWith('.git/')) continue;
      const parsed = legacyDocument(bytes.toString('utf8'));
      const renamed = /(?:--)?[a-f0-9]{8}-[a-f0-9-]{27,}\.md$/i.test(path) ? join(dirname(path), safeTitle(parsed.title ?? basename(path, '.md')) + '.md') : path;
      const to = unique(renamed, used); mapping.set(path, to);
      if (parsed.id) {
        if (ids.has(parsed.id)) { ids.delete(parsed.id); ambiguous.add(parsed.id); }
        else if (!ambiguous.has(parsed.id)) ids.set(parsed.id, to);
      }
      notes.set(path, parsed);
    }
    for (const [path, parsed] of notes) for (const [index, asset] of parsed.assets.entries()) {
      const old = assetDestination(path, asset.target);
      if (mapping.has(old)) continue;
      const ext = old.slice(old.lastIndexOf('.'));
      if (!original.has(old)) throw new InvalidRequestError('Диаграмма источника отсутствует', { path: old });
      const to = old.startsWith('_assets/') ? unique(`Схемы/${safeTitle(parsed.title ?? basename(path, '.md'))} — ${safeTitle(asset.title || 'Диаграмма ' + (index + 1))}${ext}`, used) : unique(old, used);
      mapping.set(old, to);
    }
    let deletedPages = 0;
    for (const [path, bytes] of original) if (path.startsWith('.livenote/trash/') && path.endsWith('.md')) {
      const parsed = legacyDocument(bytes.toString('utf8'));
      const to = unique('.livenote/trash/migration/' + safeTitle(parsed.title ?? basename(path, '.md')) + '.md', used);
      mapping.set(path, to); notes.set(path, parsed); deletedPages++;
      for (const [index, asset] of parsed.assets.entries()) {
        const old = migrationDestination(path, asset.target);
        if (!original.has(old)) throw new InvalidRequestError('Диаграмма удалённой заметки отсутствует', { path: old });
        if (!mapping.has(old)) mapping.set(old, unique('.livenote/trash/migration/Схемы/' + safeTitle(parsed.title ?? 'Удалённая заметка') + ' — ' + safeTitle(asset.title ?? 'Диаграмма ' + (index + 1)) + posix.extname(old), used));
      }
    }
    for (const path of original.keys()) if (!path.startsWith('.livenote/') && !path.startsWith('.git/') && !mapping.has(path)) {
      const readable = path.startsWith('_assets/') && diagramFormat(path) ? 'Схемы/Архив — Диаграмма ' + (mapping.size + 1) + posix.extname(path) : path;
      mapping.set(path, unique(readable, used));
    }
    const files: NativeFile[] = [];
    for (const [old, path] of mapping) {
      const bytes = original.get(old);
      if (!bytes) throw new InvalidRequestError('Отсутствует исходный файл');
      const parsed = notes.get(old);
      files.push({ path, source: parsed ? rewriteMigrationLinks(parsed.source, old, mapping, ids, path) : bytes });
    }
    const archive = [...original].filter(([path]) => !path.startsWith('.livenote/lock') && !path.startsWith('.livenote/cache/')).map(([path, source]) => ({ path: 'original/' + path, source }));
    const retainedFolders = folders.filter(path => !path.startsWith('_assets')).filter(path => !files.some(file => file.path === path));
    writeMigration(staged, files, archive, { source: 'vault', paths: [...mapping].map(([from, to]) => ({ from, to })), checksums: [...original].map(([path, source]) => ({ path, version: fileVersion(source) })) }, retainedFolders);
    const before = new Map([...original].map(([path, bytes]) => [join(sourceRoot, path), bytes]));
    unchanged([...before.keys()], before);
    publish(staged, target); return { pages: notes.size - deletedPages, deletedPages, warning };
  } finally { if (existsSync(staged)) rmSync(staged, { recursive: true, force: true }); }
}
