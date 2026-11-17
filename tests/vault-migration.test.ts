import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, DEFAULT_VAULT } from '../src/server/config.ts';
import { migrateFromVault, migrateVault } from '../src/server/vaultMigration.ts';
import { NoteStore } from '../src/server/db.ts';
import { VaultStore } from '../src/server/vault.ts';
import { sha256 } from '../src/server/vaultDocument.ts';
import { createApp } from '../src/server/app.ts';
import { AppError } from '../src/server/errors.ts';

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'vault-migration-')); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('CLI storage flags environment precedence and explicit migration sources are unambiguous', () => {
  const defaults = parseConfig([], {}); assert.equal(defaults.command, 'serve');
  assert.equal(defaults.command === 'serve' && defaults.config.vaultPath, DEFAULT_VAULT);
  const vault = parseConfig(['--vault', 'notes'], { LIVENOTE_DB: '/db', LIVENOTE_VAULT: '/other' }, '/cwd');
  assert.equal(vault.command === 'serve' && vault.config.vaultPath, '/cwd/notes');
  const db = parseConfig(['--db', 'legacy.sqlite'], { LIVENOTE_DB: '/db', LIVENOTE_VAULT: '/other' }, '/cwd');
  assert.equal(db.command === 'serve' && db.config.vaultPath, undefined);
  assert.equal(db.command === 'serve' && db.config.dbPath, '/cwd/legacy.sqlite');
  assert.throws(() => parseConfig(['--vault', 'a', '--db', 'b'], {}));
  assert.throws(() => parseConfig([], { LIVENOTE_DB: 'db', LIVENOTE_VAULT: 'vault' }));
  assert.throws(() => parseConfig(['--vault', ''], {}));
  assert.throws(() => parseConfig([], { LIVENOTE_VAULT: '' }));
  assert.throws(() => parseConfig(['--port', '12garbage'], {}));
  assert.throws(() => parseConfig(['migrate', '--db', 'source'], {}));
  assert.throws(() => parseConfig(['migrate', '--db', 'db', '--from-vault', 'old', '--vault', 'new'], {}));
  assert.deepEqual(parseConfig(['migrate', '--db', 'source', '--vault', 'target'], {}, '/cwd'), { command: 'migrate', dbPath: '/cwd/source', vaultPath: '/cwd/target' });
  assert.deepEqual(parseConfig(['migrate', '--from-vault', 'source', '--vault', 'target'], {}, '/cwd'), { command: 'migrate-vault', sourcePath: '/cwd/source', vaultPath: '/cwd/target' });
});

test('SQLite migration copies WAL snapshot without changing DB WAL SHM and preserves sources and deleted pages', () => {
  const directory = root(); const dbPath = join(directory, 'source.sqlite'); const legacy = new NoteStore(dbPath);
  let page = legacy.createPage('Same title');
  page = legacy.upsertBlock(page.id, 'intro', 'markdown', '# Exact text\n\n', page.revision).page;
  page = legacy.upsertBlock(page.id, 'flow', 'mermaid', 'flowchart LR\n A --> B', page.revision, 'Flow title').page;
  page = legacy.upsertBlock(page.id, 'process', 'bpmn', '<definitions>\r\n</definitions>', page.revision, 'BPMN title').page;
  page = legacy.upsertBlock(page.id, 'architecture', 'drawio', '<mxfile>  </mxfile>', page.revision, 'XML title').page;
  const deleted = legacy.createPage('Deleted'); legacy.softDeletePage(deleted.id, deleted.revision);
  const paths = [dbPath, dbPath + '-wal', dbPath + '-shm']; const hashes = paths.map(path => sha256(readFileSync(path))); const target = join(directory, 'vault');
  try {
    assert.deepEqual({ ...migrateVault(dbPath, target), warning: '' }, { pages: 1, deletedPages: 1, warning: '' });
    assert.deepEqual(paths.map(path => sha256(readFileSync(path))), hashes);
    const migrated = new VaultStore(target);
    try {
      const saved = migrated.document('Same title.md');
      assert.equal(saved.page.id, 'Same title.md');
      assert.ok(saved.source.startsWith('# Exact text\n\n'));
      assert.equal(saved.page.blocks.find(block => block.type === 'mermaid')?.source, page.blocks.find(block => block.type === 'mermaid')?.source);
      assert.deepEqual(saved.assets.map(asset => asset.source), ['<definitions>\r\n</definitions>', '<mxfile>  </mxfile>']);
      assert.equal(migrated.listPages().length, 1);
      assert.ok(migrated.files.list('.livenote/trash/migration', true).files.some(path => path.endsWith('Deleted.md')));
      const records = JSON.parse(readFileSync(join(target, '.livenote/migration/blocks.json'), 'utf8'));
      assert.deepEqual(records[0].blocks.map((block: { source: string }) => block.source), page.blocks.map(block => block.source));
      assert.deepEqual(readFileSync(join(target, '.livenote/migration/original/source.sqlite-wal')), readFileSync(dbPath + '-wal'));
      const moved = migrated.move(saved.path, { expectedRevision: saved.page.revision, expectedVersion: saved.version, path: 'Moved/Exact.md' });
      assert.equal(moved.document?.assets[0]?.source, '<definitions>\r\n</definitions>');
    } finally { migrated.close(); }
    assert.throws(() => migrateVault(dbPath, target));
    assert.equal(readdirSync(directory).filter(name => name.includes('-migration-')).length, 0);
  } finally { legacy.close(); }
});

test('invalid SQLite migration leaves source unchanged and removes its staging directory', () => {
  const directory = root(); const dbPath = join(directory, 'source.sqlite'); const legacy = new NoteStore(dbPath); const page = legacy.createPage('Invalid');
  const raw = new Database(dbPath); raw.prepare('UPDATE pages SET id = ? WHERE id = ?').run('invalid/id', page.id); raw.close();
  const before = sha256(readFileSync(dbPath + '-wal'));
  try {
    assert.throws(() => migrateVault(dbPath, join(directory, 'vault')));
    assert.equal(existsSync(join(directory, 'vault')), false);
    assert.equal(sha256(readFileSync(dbPath + '-wal')), before);
    assert.equal(readdirSync(directory).filter(name => name.includes('-migration-')).length, 0);
  } finally { legacy.close(); }
});

test('SQLite newline-free adjacent blocks remain in ordinary source and exact provenance records', () => {
  const directory = root(); const dbPath = join(directory, 'source.sqlite'); const legacy = new NoteStore(dbPath);
  let page = legacy.createPage('Framing');
  page = legacy.upsertBlock(page.id, 'first', 'markdown', 'first without newline', page.revision).page;
  page = legacy.upsertBlock(page.id, 'second', 'markdown', 'last without newline', page.revision).page;
  page = legacy.upsertBlock(page.id, 'diagram', 'drawio', '<mxfile>\r\n</mxfile>', page.revision).page;
  const target = join(directory, 'vault');
  try {
    migrateVault(dbPath, target); const migrated = new VaultStore(target);
    try {
      const d = migrated.document('Framing.md');
      assert.ok(d.source.startsWith('first without newline\n\nlast without newline\n\n'));
      assert.equal(d.assets[0]?.source, '<mxfile>\r\n</mxfile>');
      const records = JSON.parse(readFileSync(join(target, '.livenote/migration/blocks.json'), 'utf8'));
      assert.deepEqual(records[0].blocks.map((block: { source: string }) => block.source), page.blocks.map(block => block.source));
    } finally { migrated.close(); }
  } finally { legacy.close(); }
});

test('dbPath-only factory keeps SQLite stable IDs numeric revision and explicit vault route rejection', async () => {
  const directory = root();
  const running = await createApp({ port: 4360, host: '127.0.0.1', dbPath: join(directory, 'legacy.sqlite'), token: null, openBrowser: false, mermaidTheme: 'default' });
  try {
    const page = running.service.addPage('Legacy'); const written = await running.service.writeBlock(page.id, 'intro', 'markdown', 'legacy', page.revision);
    assert.equal(written.revision, page.revision + 1); assert.equal(written.blockId, 'intro');
    assert.throws(() => running.service.getDocument(page.id), (error: unknown) => error instanceof AppError && error.code === 'vault_required');
    assert.throws(() => running.service.addPage('bad', undefined, { path: 'Bad.md' }), (error: unknown) => error instanceof AppError && error.code === 'invalid_request');
  } finally { await running.close(); await running.close(); }
});

test('legacy vault migration strips only obsolete fields and markers with readable assets and rewritten ID links', () => {
  const directory = root(); const source = join(directory, 'source'); mkdirSync(join(source, '_assets/old-page'), { recursive: true }); mkdirSync(join(source, 'Empty/Nested'), { recursive: true });
  const name = 'Old--00000000-0000-4000-8000-000000000001.md';
  const original = '---\nid: old-page\ntitle: Readable\ncreated: "2020-01-01T00:00:00Z"\nupdated: "2020-01-02T00:00:00Z"\n# user comment\nunknown: {x: 42}\naliases: [Alias]\n---\n<!-- livenote:block {"id":"intro","type":"markdown","framingNewline":true} -->\nExact prose\n<!-- livenote:block {"id":"xml","type":"drawio","title":"Architecture","custom":42} -->\n![Old](_assets/old-page/xml.drawio)\n';
  const xml = '<?xml version="1.0"?>\r\n<mxfile> exact </mxfile>';
  writeFileSync(join(source, name), original); writeFileSync(join(source, '_assets/old-page/xml.drawio'), xml); writeFileSync(join(source, 'Link.md'), '[[old-page|kept label]]');
  const binary = Buffer.from([255, 0, 127]); writeFileSync(join(source, 'binary.bin'), binary);
  const before = [name, '_assets/old-page/xml.drawio', 'Link.md', 'binary.bin'].map(path => sha256(readFileSync(join(source, path)))); const target = join(directory, 'native');
  const result = migrateFromVault(source, target); assert.equal(result.pages, 2);
  assert.deepEqual([name, '_assets/old-page/xml.drawio', 'Link.md', 'binary.bin'].map(path => sha256(readFileSync(join(source, path)))), before);
  const store = new VaultStore(target);
  try {
    const d = store.document('Readable.md');
    assert.match(d.source, /# user comment\nunknown: \{x: 42\}\naliases: \[Alias\]/);
    assert.doesNotMatch(d.source, /livenote:block|^id:|^created:|^updated:/m);
    assert.deepEqual(d.assets.map(asset => [asset.path, asset.source]), [['Схемы/Readable — Architecture.drawio', xml]]);
    assert.equal(store.document('Link.md').source, '[[Readable.md|kept label]]');
    assert.ok(store.snapshot().folders.includes('Empty/Nested'));
    assert.deepEqual(readFileSync(join(target, 'binary.bin')), binary);
    assert.equal(readFileSync(join(target, '.livenote/migration/original', name), 'utf8'), original);
  } finally { store.close(); }
  assert.throws(() => migrateFromVault(source, join(source, 'inside')));
});

test('legacy vault migration rejects symlinks journals markers and nested destinations without modifying source', () => {
  for (const kind of ['symlink', 'journal', 'marker', 'nested-destination']) {
    const directory = root(); const source = join(directory, 'source'); mkdirSync(source); writeFileSync(join(source, 'Note.md'), 'plain');
    if (kind === 'symlink') symlinkSync(join(source, 'Note.md'), join(source, 'link.md'));
    if (kind === 'journal') { mkdirSync(join(source, '.livenote/transactions/unfinished'), { recursive: true }); writeFileSync(join(source, '.livenote/transactions/unfinished/journal.json'), '{}'); }
    if (kind === 'marker') writeFileSync(join(source, 'Note.md'), '<!-- livenote:block broken -->\ntext');
    const before = readdirSync(source);
    assert.throws(() => migrateFromVault(source, kind === 'nested-destination' ? join(source, 'Never/Created/Native') : join(directory, 'native')));
    assert.deepEqual(readdirSync(source), before);
    assert.equal(existsSync(join(directory, 'native')), false);
    assert.equal(readdirSync(directory).filter(name => name.includes('-migration-')).length, 0);
  }
});
