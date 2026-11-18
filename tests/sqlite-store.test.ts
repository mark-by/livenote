import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteStore } from '../src/server/db.ts';
import { ConflictError } from '../src/server/errors.ts';

test('SQLite deletion removes the page row and its blocks while preserving other pages', t => {
  // Arrange: две страницы содержат независимые блоки.
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-delete-'));
  const dbPath = join(directory, 'notes.sqlite');
  const store = new NoteStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const removed = store.createPageWithBlocks('Удаляемая страница', [{ id: 'removed-text', type: 'markdown', source: 'Удаляемый текст' }]);
  const retained = store.createPageWithBlocks('Оставшаяся страница', [{ id: 'retained-text', type: 'markdown', source: 'Оставшийся текст' }]);

  // Act: удаляем страницу с актуальной ревизией.
  store.deletePage(removed.id, removed.revision);

  // Assert: строки удалены из таблиц, а не скрыты отметкой deleted_at.
  const database = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(database.prepare('SELECT id FROM pages ORDER BY id').all(), [{ id: retained.id }]);
    assert.deepEqual(database.prepare('SELECT page_id, source FROM blocks').all(), [{ page_id: retained.id, source: 'Оставшийся текст' }]);
    assert.equal(store.getPage(removed.id), undefined);
  } finally { database.close(); }
});

test('SQLite deletion with a stale revision leaves the page and blocks intact', t => {
  // Arrange: после чтения страницы её содержимое изменилось.
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-stale-delete-'));
  const store = new NoteStore(join(directory, 'notes.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const before = store.createPage('Изменённая страница');
  const current = store.upsertBlock(before.id, 'text', 'markdown', 'Новая версия', before.revision).page;

  // Act и Assert: устаревшее удаление отклоняется, данные остаются.
  assert.throws(() => store.deletePage(before.id, before.revision), ConflictError);
  assert.deepEqual(store.getPage(before.id), current);
});
