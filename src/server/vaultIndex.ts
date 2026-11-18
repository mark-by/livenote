import Database from 'better-sqlite3';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z, ZodError } from 'zod';
import { sha256 } from './vaultDocument.js';
import { fileStamp } from './vaultFiles.js';

const blockType = z.enum(['markdown', 'mermaid', 'bpmn', 'drawio']);
const offset = z.number().int().nonnegative();
const version = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const problem = z.object({
  code: z.enum(['missing_id', 'invalid_frontmatter', 'duplicate_page_id', 'invalid_block', 'duplicate_block_id',
    'missing_asset', 'unsafe_path', 'git_conflict', 'unreadable_file']),
  path: z.string(), message: z.string(), pageId: z.string().optional(), blockId: z.string().optional(),
});
const fileRecord = z.object({
  stamp: z.string(), version, mtimeMs: z.number(), birthtimeMs: z.number(),
  text: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('binary') }),
    z.object({ kind: z.literal('invalid') }),
    z.object({ kind: z.literal('conflict'), source: z.string() }),
    z.object({
      kind: z.literal('document'), source: z.string(),
      syntax: z.object({
        spans: z.array(z.object({
          id: z.string(), type: blockType, start: offset, end: offset, contentStart: offset, contentEnd: offset,
          assetPath: z.string().optional(), destinationStart: offset.optional(), destinationEnd: offset.optional(),
          title: z.string().nullable().optional(),
        })),
        problems: z.array(problem), aliases: z.array(z.string()), tags: z.array(z.string()), prose: z.string(),
      }),
      links: z.array(z.object({
        target: z.string(), targetPageId: z.null(), label: z.string().nullable(), fragment: z.string().nullable(),
        kind: z.enum(['wiki', 'markdown']), start: offset, end: offset, fullStart: offset, fullEnd: offset,
      })),
    }),
  ]),
});
export type VaultFileRecord = Readonly<z.infer<typeof fileRecord>>;
const row = z.object({ path: z.string(), payload: z.string(), checksum: z.string() });
const schemaVersion = 1;

class InvalidIndex extends Error {}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function cacheStamp(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new InvalidIndex('Путь индекса не является отдельным файлом');
    return fileStamp(stat);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function canonicalDirectory(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if (!missing(error) || dirname(path) === path) throw error;
    return join(canonicalDirectory(dirname(path)), basename(path));
  }
}

/** SQLite хранит только проверенные записи. Сбой индекса не меняет файлы Vault. */
export class VaultIndex {
  private readonly path: string;
  private persisted = new Map<string, VaultFileRecord>();
  private stamp: string | null = null;

  constructor(path: string, private readonly root: string) { this.path = resolve(path); }

  private location(): string {
    const directory = canonicalDirectory(dirname(this.path));
    const fromRoot = relative(this.root, directory);
    if (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith('..' + sep)) {
      throw new InvalidIndex('Индекс должен находиться вне Vault');
    }
    return join(directory, basename(this.path));
  }

  load(): ReadonlyMap<string, VaultFileRecord> {
    try {
      const path = this.location();
      const stamp = cacheStamp(path);
      if (stamp === null) return this.persisted;
      const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 0 });
      try {
        if (db.pragma('user_version', { simple: true }) !== schemaVersion ||
            db.prepare('SELECT root FROM vault').pluck().get() !== this.root) throw new InvalidIndex('Схема индекса устарела');
        const result = new Map<string, VaultFileRecord>();
        for (const item of db.prepare('SELECT path, payload, checksum FROM files').iterate()) {
          const { path, payload, checksum } = row.parse(item);
          if (sha256(path + '\0' + payload) !== checksum) throw new InvalidIndex('Контрольная сумма записи не совпадает');
          result.set(path, fileRecord.parse(JSON.parse(payload)));
        }
        if (cacheStamp(path) === stamp) { this.persisted = result; this.stamp = stamp; }
      } finally { db.close(); }
    } catch (error) {
      if (!(error instanceof ZodError || error instanceof SyntaxError || this.cacheError(error))) throw error;
    }
    return this.persisted;
  }

  save(records: Map<string, VaultFileRecord>): void {
    try {
      const path = this.location();
      const stamp = cacheStamp(path);
      if (stamp === null || stamp !== this.stamp) {
        this.replace(path, stamp, records);
      } else {
        const changed = [...records].filter(([file, record]) => this.persisted.get(file) !== record);
        const removed = [...this.persisted.keys()].filter(file => !records.has(file));
        if (!changed.length && !removed.length) return;
        const db = new Database(path, { fileMustExist: true, timeout: 0 });
        try { this.write(db, changed, removed); }
        finally { db.close(); }
      }
      this.stamp = cacheStamp(path);
      this.persisted = records;
    } catch (error) {
      if (!this.cacheError(error)) throw error;
      this.stamp = null;
    }
  }

  private replace(path: string, stamp: string | null, records: Map<string, VaultFileRecord>): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = mkdtempSync(join(directory, '.index-'));
    try {
      const next = join(temporary, 'index.sqlite');
      const db = new Database(next);
      try {
        db.exec(`PRAGMA user_version = ${schemaVersion};
          CREATE TABLE vault (root TEXT NOT NULL);
          CREATE TABLE files (path TEXT PRIMARY KEY, payload TEXT NOT NULL, checksum TEXT NOT NULL) WITHOUT ROWID;`);
        db.prepare('INSERT INTO vault VALUES (?)').run(this.root);
        this.write(db, records, []);
      } finally { db.close(); }
      if (cacheStamp(path) !== stamp) throw new InvalidIndex('Индекс заменён во время восстановления');
      renameSync(next, path);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }

  private write(db: Database.Database, changed: Iterable<readonly [string, VaultFileRecord]>, removed: readonly string[]): void {
    const put = db.prepare('INSERT OR REPLACE INTO files VALUES (?, ?, ?)');
    const drop = db.prepare('DELETE FROM files WHERE path = ?');
    db.transaction(() => {
      for (const file of removed) drop.run(file);
      for (const [file, record] of changed) {
        const payload = JSON.stringify(record);
        put.run(file, payload, sha256(file + '\0' + payload));
      }
    })();
  }

  private cacheError(error: unknown): boolean {
    return error instanceof InvalidIndex || error instanceof Database.SqliteError ||
      (error instanceof Error && 'code' in error && typeof error.code === 'string');
  }
}
