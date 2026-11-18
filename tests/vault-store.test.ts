import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultStore } from '../src/server/vault.ts';
import { fileVersion, sha256 } from '../src/server/vaultDocument.ts';
import { AppError } from '../src/server/errors.ts';
import type { VaultDocument } from '../src/shared/types.ts';
import { execFileSync } from 'node:child_process';

const roots: string[] = []; const stores: VaultStore[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), 'vault-store-')); roots.push(root); const store = new VaultStore(root); stores.push(store); return { root, store }; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tokens = (d: VaultDocument) => ({ expectedRevision: d.page.revision, expectedVersion: d.version });
const conflict = (error: unknown) => error instanceof AppError && error.httpStatus === 409;
function save(store: VaultStore, d: VaultDocument, source: string) { return store.finish(d.path, store.prepare(d.path, { ...tokens(d), source })); }

test('nested plain notes rebuild identical fingerprints without read or no-op mtime churn', () => {
  const { root, store } = fixture(); const page = store.createPage('A', { path: 'Folder/Nested/A.md', source: '#tag\nbody' });
  const document = store.document(page.id); const before = statSync(join(root, page.id)).mtimeMs;
  assert.equal(page.id, 'Folder/Nested/A.md');
  assert.deepEqual(store.snapshot().tags, [{ tag: 'tag', count: 1 }]);
  assert.equal(save(store, document, document.source).version, document.version);
  assert.equal(store.updatePage(page.id, {}, page.revision).revision, page.revision);
  assert.equal(statSync(join(root, page.id)).mtimeMs, before);
  store.close(); const rebuilt = new VaultStore(root); stores.push(rebuilt);
  assert.equal(rebuilt.document(page.id).version, document.version);
  assert.equal(readFileSync(join(root, page.id), 'utf8'), '#tag\nbody');
});

test('external Markdown and shared diagram bytes reject stale revision and full versions', () => {
  const { root, store } = fixture(); const page = store.createPage('Diagram');
  const before = store.document(page.id);
  const d = store.finish(page.id, store.prepare(page.id, { ...tokens(before), source: '![x](A.drawio)', assets: [{ path: 'A.drawio', source: '<mxfile/>', expectedVersion: null }] }));
  writeFileSync(join(root, 'A.drawio'), '<mxfile changed="external"/>');
  assert.throws(() => save(store, d, d.source + 'stale'), conflict);
  const fresh = store.document(page.id);
  assert.notEqual(fresh.version, d.version);
  writeFileSync(join(root, page.id), fresh.source + 'external prose');
  assert.throws(() => store.prepare(page.id, { ...tokens(fresh), source: 'stale' }), conflict);
});

test('removing the last vault embed deletes its diagram but preserves shared diagrams', () => {
  const { root, store } = fixture();
  store.createPage('Shared', { path: 'Shared.drawio', source: '<mxfile/>' });
  store.createPage('Unused', { path: 'Unused.bpmn', source: '<xml/>' });
  const page = store.createPage('One', { source: '![a](Shared.drawio) ![b](Shared.drawio) ![c](Unused.bpmn)' });
  store.createPage('Two', { source: '![[Shared.drawio]]' });
  const before = store.document(page.id);

  // Act: сохраняем документ без одного общего и единственного отдельного встраивания.
  const result = save(store, before, '![b](Shared.drawio)');

  // Assert: общий файл остаётся, а файл без встраиваний удалён.
  assert.equal(result.source, '![b](Shared.drawio)');
  assert.equal(readFileSync(join(root, 'Shared.drawio'), 'utf8'), '<mxfile/>');
  assert.equal(existsSync(join(root, 'Unused.bpmn')), false);
  assert.equal(store.document('Two.md').source, '![[Shared.drawio]]');
});

test('deleting a document removes only diagrams with no remaining embeds', () => {
  const { root, store } = fixture();
  store.createPage('Shared', { path: 'Shared.drawio', source: '<mxfile/>' });
  store.createPage('Unique', { path: 'Unique.mmd', source: 'graph TD' });
  const page = store.createPage('One', { source: '![a](Shared.drawio) ![b](Unique.mmd)' });
  store.createPage('Two', { source: '![a](Shared.drawio)' });

  // Act: удаляем документ с общей и отдельной диаграммами.
  store.deletePage(page.id, page.revision);

  // Assert: файл общей диаграммы остаётся, отдельный файл удалён.
  assert.equal(existsSync(join(root, 'Shared.drawio')), true);
  assert.equal(existsSync(join(root, 'Unique.mmd')), false);
  assert.equal(store.document('Two.md').source, '![a](Shared.drawio)');
});

test('removing a diagram rejects asset changes after preparation', () => {
  const { root, store } = fixture();
  store.createPage('Diagram', { path: 'Diagram.drawio', source: '<mxfile/>' });
  const page = store.createPage('One', { source: '![a](Diagram.drawio)' });
  const before = store.document(page.id);
  const prepared = store.prepare(page.id, { ...tokens(before), source: '' });
  writeFileSync(join(root, 'Diagram.drawio'), '<mxfile changed="yes"/>');

  // Act и Assert: устаревшее сохранение отклоняется без удаления файла.
  assert.throws(() => store.finish(page.id, prepared), conflict);
  assert.equal(readFileSync(join(root, 'Diagram.drawio'), 'utf8'), '<mxfile changed="yes"/>');
  assert.equal(store.document(page.id).source, before.source);
});

test('removing one of several embeds keeps the asset until its last embed is removed', () => {
  const { root, store } = fixture();
  store.createPage('Diagram', { path: 'Diagram.drawio', source: '<mxfile/>' });
  const page = store.createPage('One', { source: '![a](Diagram.drawio) ![b](Diagram.drawio)' });
  const before = store.document(page.id);

  // Act: удаляем одно встраивание и затем последнее.
  const remaining = save(store, before, '![b](Diagram.drawio)');
  assert.equal(readFileSync(join(root, 'Diagram.drawio'), 'utf8'), '<mxfile/>');
  save(store, remaining, '');

  // Assert: файл удалён только после последнего встраивания.
  assert.equal(existsSync(join(root, 'Diagram.drawio')), false);
});

test('unreadable documents prevent deletion of potentially shared diagrams', () => {
  const { root, store } = fixture();
  store.createPage('Diagram', { path: 'Diagram.drawio', source: '<mxfile/>' });
  const page = store.createPage('One', { source: '![a](Diagram.drawio)' });
  writeFileSync(join(root, 'Conflict.md'), '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n');
  const before = store.document(page.id);

  // Act: удаляем встраивание, когда другой документ нельзя прочитать.
  save(store, before, '');

  // Assert: файл сохранён, поскольку проверить все встраивания нельзя.
  assert.equal(readFileSync(join(root, 'Diagram.drawio'), 'utf8'), '<mxfile/>');
});

test('editing one of two identical fences replaces its range and retains every unrelated byte', () => {
  const { store } = fixture(); const fence = '```mermaid\r\nflowchart LR\r\n A-->B\r\n```';
  const source = '---\nid: old\r\nunknown: 42 # keep\r\n---\r\n' + fence + '\r\n\r\n' + fence + '\r\nlast';
  const page = store.createPage('Source', { source }); const before = store.document(page.id);
  const middle = before.page.blocks.filter(block => block.type === 'mermaid')[1];
  assert.ok(middle);
  const result = store.upsertBlock(page.id, middle.id, 'mermaid', 'flowchart LR\r\n C-->D', page.revision);
  assert.equal(store.document(page.id).source, source.slice(0, source.lastIndexOf(fence)) + fence.replace('A-->B', 'C-->D') + '\r\nlast');
  assert.equal(result.blockId, middle.id);
  const cleared = store.updatePage(page.id, { deleteBlockIds: result.page.blocks.map(block => block.id) }, result.page.revision);
  assert.equal(cleared.blocks.length, 0);
  assert.equal(store.document(page.id).source, '');
});

test('path traversal reserved paths and symlink roots or descendants cannot escape the vault', () => {
  const { root, store } = fixture();
  for (const path of ['../escape.md', '/absolute.md', 'C:/drive.md', 'a\\b.md', 'a//b.md', '.git/note.md', '.livenote/note.md', 'a/./b.md', 'a/../b.md']) assert.throws(() => store.createPage('bad', { path }));
  assert.equal(store.createPage('allowed', { path: '_assets/allowed.md' }).id, '_assets/allowed.md');
  const outside = mkdtempSync(join(tmpdir(), 'vault-outside-')); roots.push(outside);
  symlinkSync(outside, join(root, 'link'));
  assert.throws(() => store.createPage('bad', { path: 'link/bad.md' }));
  const symlinkRoot = join(outside, 'root-link'); symlinkSync(root, symlinkRoot);
  assert.throws(() => new VaultStore(symlinkRoot));
  assert.ok(store.snapshot().problems.some(problem => problem.code === 'unsafe_path'));
  assert.equal(existsSync(join(outside, 'bad.md')), false);
  store.close();
  unlinkSync(join(root, '.livenote/.gitignore'));
  const externalIgnore = join(outside, 'ignore'); writeFileSync(externalIgnore, 'outside');
  symlinkSync(externalIgnore, join(root, '.livenote/.gitignore'));
  assert.throws(() => new VaultStore(root));
  assert.equal(readFileSync(externalIgnore, 'utf8'), 'outside');
});

test('plain and duplicate YAML ID notes stay readable while Git conflicts quarantine only their file', () => {
  const { root, store } = fixture();
  for (const [path, source] of [['NoId.md', '# untouched'], ['A.md', '---\nid: duplicate\n---\na'], ['B.md', '---\nid: duplicate\n---\nb'], ['Missing.md', '![x](Missing.drawio)'], ['Conflict.md', '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n']] as const) writeFileSync(join(root, path), source);
  assert.deepEqual(store.snapshot().pages.map(page => page.id), ['A.md', 'B.md', 'Missing.md', 'NoId.md']);
  assert.equal(store.document('Missing.md').assets[0]?.source, null);
  assert.ok(store.snapshot().problems.some(problem => problem.code === 'git_conflict'));
  assert.throws(() => store.document('Conflict.md'), conflict);
  writeFileSync(join(root, 'Conflict.md'), 'resolved');
  assert.equal(store.document('Conflict.md').source, 'resolved');
});

test('writer lock durable replay and permanent deletion preserve independently shared diagram files', () => {
  const { root, store } = fixture();
  assert.throws(() => new VaultStore(root), conflict);
  const page = store.atomic('create-key', { title: 'Created' }, () => store.createPage('Created'));
  store.close(); const restart = new VaultStore(root); stores.push(restart);
  assert.equal(restart.atomic<typeof page>('create-key', { title: 'Created' }, () => { throw new Error('must replay'); }).id, page.id);
  assert.throws(() => restart.atomic('create-key', { title: 'Other' }, () => page), (error: unknown) => error instanceof AppError && error.code === 'idempotency_key_reuse');
  const before = restart.document(page.id);
  const d = restart.finish(page.id, restart.prepare(page.id, { ...tokens(before), source: '![x](Shared.drawio)', assets: [{ path: 'Shared.drawio', source: '<mxfile/>', expectedVersion: null }] }));
  restart.createPage('Other', { source: '![x](Shared.drawio)' });
  restart.deletePage(page.id, d.page.revision);
  assert.equal(restart.listPages().length, 1);
  assert.equal(readFileSync(join(root, 'Shared.drawio'), 'utf8'), '<mxfile/>');
  assert.equal(existsSync(join(root, page.id)), false);
  assert.equal(existsSync(join(root, '.livenote/trash')), false);
});

test('restart completes recognized journals and quarantines unknown third-party bytes', () => {
  const { root, store } = fixture(); store.close(); const tx = join(root, '.livenote/transactions/recovery'); mkdirSync(tx, { recursive: true });
  const old = 'old'; const next = 'new'; const encoded = (value: string) => Buffer.from(value).toString('base64');
  writeFileSync(join(root, 'Recover.md'), old);
  const journal = { id: 'recovery', changes: [{ path: 'Recover.md', old: encoded(old), next: encoded(next), oldHash: sha256(old), newHash: sha256(next) }] };
  writeFileSync(join(tx, 'journal.json'), JSON.stringify(journal));
  const recovered = new VaultStore(root); stores.push(recovered);
  assert.equal(recovered.document('Recover.md').source, 'new'); recovered.close();
  mkdirSync(tx, { recursive: true }); writeFileSync(join(root, 'Recover.md'), 'third-party'); writeFileSync(join(tx, 'journal.json'), JSON.stringify(journal));
  const quarantined = new VaultStore(root); stores.push(quarantined);
  assert.equal(readFileSync(join(root, 'Recover.md'), 'utf8'), 'third-party');
  assert.ok(existsSync(join(tx, 'journal.json')));
  assert.throws(() => quarantined.document('Recover.md'), conflict);
});

test('append replace and reorder retain newline-free content beside diagrams in LF and CRLF', () => {
  for (const newline of ['\n', '\r\n']) {
    const { store } = fixture(); let page = store.createPage('Framing', { source: 'original without newline' });
    page = store.upsertBlock(page.id, undefined, 'drawio', '<mxfile>\r\n</mxfile>', page.revision).page;
    assert.ok(store.document(page.id).source.startsWith('original without newline' + newline.slice(-1)));
    const first = page.blocks[0]; assert.ok(first);
    page = store.upsertBlock(page.id, first.id, 'markdown', 'changed without newline\n', page.revision).page;
    const diagram = page.blocks.find(block => block.type === 'drawio'); assert.ok(diagram);
    assert.equal(diagram.source, '<mxfile>\r\n</mxfile>');
    const order = [...page.blocks].reverse().map(block => block.id);
    page = store.updatePage(page.id, { blockOrder: order }, page.revision);
    assert.equal(page.blocks.find(block => block.type === 'drawio')?.source, '<mxfile>\r\n</mxfile>');
  }
});

test('empty nested folder moves include binary bytes and rewrite incoming outgoing and shared asset links', () => {
  const { root, store } = fixture();
  store.createFolder('Docs/Empty/Nested', store.snapshot().treeVersion);
  store.createPage('One', { path: 'Docs/One.md', source: '[other](../Other.md) ![x](Shared.drawio)' });
  store.createPage('Other', { path: 'Other.md', source: '[[Docs/One|label]] ![x](Docs/Shared.drawio)' });
  store.createPage('Shared', { path: 'Docs/Shared.drawio', format: 'drawio', source: '<mxfile/>' });
  const binary = Buffer.from([0, 255, 239, 128]); writeFileSync(join(root, 'Docs/data.bin'), binary);
  const moved = store.moveFolder('Docs', 'Moved/Docs', store.snapshot().treeVersion);
  assert.ok(moved.moved.some(entry => entry.from === 'Docs/Empty/Nested' && entry.to === 'Moved/Docs/Empty/Nested'));
  assert.ok(store.snapshot().folders.includes('Moved/Docs/Empty/Nested'));
  assert.deepEqual(readFileSync(join(root, 'Moved/Docs/data.bin')), binary);
  assert.equal(store.document('Moved/Docs/One.md').source, '[other](../../Other.md) ![x](Shared.drawio)');
  assert.equal(store.document('Other.md').source, '[[Moved/Docs/One.md|label]] ![x](Moved/Docs/Shared.drawio)');
  assert.throws(() => store.createFolder('Stale', moved.treeVersion + 'x'), conflict);
  assert.throws(() => store.moveFolder('Moved', 'Moved/Sub', store.snapshot().treeVersion));
  assert.throws(() => store.deleteFolder('Moved', store.snapshot().treeVersion), conflict);
  store.deleteFolder('Moved', store.snapshot().treeVersion, true);
  assert.equal(existsSync(join(root, 'Moved')), false);
  assert.equal(existsSync(join(root, '.livenote/trash')), false);
  assert.equal(store.document('Other.md').links[0]?.targetPageId, null);
});

test('asset CAS is create-if-absent and newly selected references are immutable guards', () => {
  const { root, store } = fixture(); const page = store.createPage('Assets'); const d = store.document(page.id);
  writeFileSync(join(root, 'Shared.drawio'), '<mxfile/>');
  assert.throws(() => store.prepare(page.id, { ...tokens(d), source: '![x](Shared.drawio)', assets: [{ path: 'Shared.drawio', source: 'replace', expectedVersion: null }] }), conflict);
  const prepared = store.prepare(page.id, { ...tokens(d), source: '![x](Shared.drawio)', references: [{ path: 'Shared.drawio', expectedVersion: fileVersion('<mxfile/>') }] });
  writeFileSync(join(root, 'Shared.drawio'), '<mxfile changed="external"/>');
  assert.throws(() => store.finish(page.id, prepared), conflict);
  assert.equal(store.document(page.id).source, '');
});

test('case-only file and folder rename stage their paths and rewrite resolved links', () => {
  const { root, store } = fixture();
  const page = store.createPage('Case', { path: 'Docs/Case.md', source: 'exact\r\nbytes' });
  store.createPage('Ref', { path: 'Ref.md', source: '[[Docs/Case|Label]]' });
  store.createFolder('Docs/Empty', store.snapshot().treeVersion);
  const d = store.document(page.id);
  store.move(d.path, { ...tokens(d), path: 'Docs/case.md' });
  assert.ok(readdirSync(join(root, 'Docs')).includes('case.md'));
  assert.equal(store.document('Ref.md').source, '[[Docs/case.md|Label]]');
  store.moveFolder('Docs', 'docs', store.snapshot().treeVersion);
  assert.ok(readdirSync(root).includes('docs'));
  assert.equal(store.document('docs/case.md').source, 'exact\r\nbytes');
  assert.ok(store.snapshot().folders.includes('docs/Empty'));
  assert.equal(store.document('Ref.md').source, '[[docs/case.md|Label]]');
});

test('combined title and block edits leave source untouched if the rename destination collides', () => {
  const { store } = fixture();
  const page = store.createPage('Original', { source: 'before\n```mermaid\nflowchart LR\n A-->B\n```' });
  store.createPage('Occupied');
  const d = store.document(page.id);
  assert.throws(() => store.updatePage(page.id, { title: 'Occupied', deleteBlockIds: ['span-1'] }, page.revision), conflict);
  assert.equal(store.document(page.id).source, d.source);
  assert.equal(store.document(page.id).version, d.version);
});

test('directory journal recovery retains nested empty folders without placeholder files', () => {
  const { root, store } = fixture(); store.close();
  mkdirSync(join(root, '.livenote/transactions/empty'), { recursive: true });
  writeFileSync(join(root, '.livenote/transactions/empty/journal.json'), JSON.stringify({ id: 'empty', changes: [], directories: [{ path: 'Empty', old: false, next: true }, { path: 'Empty/Nested', old: false, next: true }] }));
  const recovered = new VaultStore(root); stores.push(recovered);
  assert.ok(recovered.snapshot().folders.includes('Empty/Nested'));
  assert.deepEqual(readdirSync(join(root, 'Empty/Nested')), []);
});

test('Unicode moves retain readable raw wiki and Markdown paths and preserve encoded destination style', () => {
  const { store } = fixture();
  const page = store.createPage('Приёмка', { path: 'Проекты/Склад/Приёмка.md', source: '[другой](../../Другое.md#этап)' });
  store.createPage('Другое', { path: 'Другое.md' });
  const encoded = ['Проекты', 'Склад', 'Приёмка.md'].map(encodeURIComponent).join('/');
  store.createPage('Обзор', { path: 'Обзор.md', source: `[[Проекты/Склад/Приёмка|Приёмка]] [план](Проекты/Склад/Приёмка.md#этап) [encoded](${encoded}#anchor) [[Приёмка]]` });
  const d = store.document(page.id);
  store.move(page.id, { ...tokens(d), path: 'Архив/Приёмка новая.md' });
  assert.equal(store.document('Обзор.md').source,
    `[[Архив/Приёмка новая.md|Приёмка]] [план](Архив/Приёмка%20новая.md#этап) [encoded](${encodeURIComponent('Архив')}/${encodeURIComponent('Приёмка новая.md')}#anchor) [[Архив/Приёмка новая.md|Приёмка]]`);
  assert.equal(store.document('Архив/Приёмка новая.md').source, '[другой](../Другое.md#этап)');
});

test('one atomic legacy block import allocates different readable files for identically titled diagrams', () => {
  const { store } = fixture();
  const page = store.createPageWithBlocks('Import', [
    { type: 'drawio', title: 'Architecture', source: '<mxfile>first</mxfile>' },
    { type: 'drawio', title: 'Architecture', source: '<mxfile>second</mxfile>' }
  ]);
  assert.deepEqual(store.document(page.id).assets.map(asset => [asset.path, asset.source]), [
    ['Схемы/Import — Architecture.drawio', '<mxfile>first</mxfile>'],
    ['Схемы/Import — Architecture 2.drawio', '<mxfile>second</mxfile>']
  ]);
});

test('real Git lists native Markdown and XML but ignores all private vault state', t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-git-')); roots.push(root);
  const userIgnore = '# User-owned root rules\nignored-by-user\n';
  writeFileSync(join(root, '.gitignore'), userIgnore);
  mkdirSync(join(root, '.livenote/migration'), { recursive: true });
  const archive = Buffer.from([0, 255, 127]); writeFileSync(join(root, '.livenote/migration/source.sqlite'), archive);
  const store = new VaultStore(root); stores.push(store);
  store.createPage('Public', { source: '# Public\n' });
  store.createPage('Diagram', { path: 'Diagram.drawio', source: '<mxfile/>' });
  const removed = store.createPage('Removed', { source: 'removed document' });
  store.deletePage(removed.id, removed.revision);
  mkdirSync(join(root, '.livenote/transactions/in-flight'), { recursive: true });
  writeFileSync(join(root, '.livenote/transactions/in-flight/journal.json'), 'private transaction bytes');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  execFileSync('git', ['-C', root, 'init', '--quiet'], { env });
  const status = execFileSync('git', ['-c', 'core.excludesFile=/dev/null', '-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], { env, encoding: 'utf8' });
  t.diagnostic('git status --porcelain=v1 --untracked-files=all\n' + status.trimEnd());
  assert.deepEqual(status.trimEnd().split('\n'), ['?? .gitignore', '?? Diagram.drawio', '?? Public.md']);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), userIgnore);
  assert.deepEqual(readFileSync(join(root, '.livenote/migration/source.sqlite')), archive);
});
