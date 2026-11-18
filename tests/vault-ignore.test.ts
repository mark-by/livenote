import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { InvalidRequestError } from '../src/server/errors.js';
import { VaultStore } from '../src/server/vault.js';
import { VaultFiles } from '../src/server/vaultFiles.js';

const rules = '.livenoteignore';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'livenote-ignore-'));
  const root = join(directory, 'vault');
  const cachePath = join(directory, 'cache', 'index.sqlite');
  let store: VaultStore | undefined;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, root, cachePath,
    put(path: string, source: string) {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    },
    open() { store = new VaultStore(root, undefined, { cachePath }); return store; },
  };
}

test('правила скрывают только каталоги по буквальному пути от корня', t => {
  // Arrange: добавляем совпадения, префиксы, обычный файл и вложенный файл правил.
  const { open, put } = fixture(t);
  put(rules, '\uFEFF# Архив\r\n\r\n /Архив/ \r\nnested/closed\nfile.md\nstar*\n!literal\n');
  put('.gitignore', 'elsewhere/\n');
  put('nested/.livenoteignore', 'elsewhere\n');
  const visible = ['file.md', 'Архивы/Note.md', 'nested/elsewhere/Note.md', 'elsewhere/Архив/Note.md', 'starfish/Note.md'];
  for (const path of [...visible, 'Архив/deep/Note.md', 'nested/closed/Note.md', 'star*/Note.md', '!literal/Note.md', '.git/Note.md', '.livenote/Note.md']) {
    put(path, 'needle');
  }
  const store = open();

  // Act: снимаем дерево и ищем общий текст.
  const snapshot = store.snapshot();
  const hits = store.search('needle');

  // Assert: видны только ожидаемые документы, а имя Vault берётся из имени корня.
  assert.deepEqual(snapshot.files.map(item => item.path).sort(), [...visible].sort());
  assert.deepEqual(hits.map(item => item.path).sort(), [...visible].sort());
  assert.deepEqual(snapshot.folders, ['', 'elsewhere', 'elsewhere/Архив', 'nested', 'nested/elsewhere', 'starfish', 'Архивы']);
  assert.equal(Reflect.get(snapshot, 'vaultName'), 'vault');
});

test('добавление и удаление файла правил меняет проекцию без повторного чтения его содержимого', t => {
  // Arrange: индекс уже содержит заметку, которую скроет новое правило.
  const { open, put, root } = fixture(t);
  put('Private/Note.md', 'needle');
  const store = open();
  const initial = store.snapshot().treeVersion;
  const reads = t.mock.method(VaultFiles.prototype, 'readBytes');

  // Act: добавляем правило и повторяем запрос с тем же файлом правил.
  put(rules, 'Private\n');
  assert.deepEqual(store.search('needle'), []);
  assert.notEqual(store.snapshot().treeVersion, initial);
  assert.deepEqual(reads.mock.calls.map(call => call.arguments[0]), [rules]);
  unlinkSync(join(root, rules));

  // Assert: удаление правила возвращает исходную проекцию без перезапуска.
  assert.equal(store.snapshot().treeVersion, initial);
  assert.deepEqual(store.search('needle').map(hit => hit.path), ['Private/Note.md']);
});

test('ZIP и индекс исключают скрытые пути, а заметка сохраняет встраивание', t => {
  // Arrange: открываем Vault, где заметка ссылается на скрытый документ и встраивает скрытую диаграмму.
  const { open, put, directory, cachePath } = fixture(t);
  put(rules, 'Private\n');
  put('Private/Note.md', 'needle');
  put('Private/Map.drawio', '<mxfile/>');
  put('Visible.md', '[note](Private/Note.md)\n\n![](Private/Map.drawio)\n');
  const store = open();

  // Act: читаем заметку и сохраняем архив во временный каталог.
  const document = store.document('Visible.md');
  const archive = join(directory, 'export.zip');
  writeFileSync(archive, store.exportArchive());

  // Assert: в ZIP и SQLite только видимый файл; скрытая диаграмма доступна во встраивании.
  const index = new Database(cachePath, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(index.prepare('SELECT path FROM files ORDER BY path').pluck().all(), ['Visible.md']); }
  finally { index.close(); }
  assert.deepEqual(execFileSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n'), ['Visible.md']);
  assert.equal(store.getPage('Private/Note.md'), undefined);
  assert.deepEqual(document.links.map(link => link.targetPageId), [null, null]);
  assert.equal(document.assets[0]?.source, '<mxfile/>');
});

test('перенос видимой заметки сохраняет путь скрытой диаграммы', t => {
  // Arrange: заметка в корне встраивает диаграмму из скрытого каталога.
  const { open, put } = fixture(t);
  put(rules, 'Private\n');
  put('Private/Map.drawio', '<mxfile/>');
  put('Visible.md', '![](Private/Map.drawio)\n');
  const store = open();
  const before = store.document('Visible.md');

  // Act: переносим заметку на уровень глубже.
  const result = store.move(before.path, {
    path: 'Public/Visible.md', expectedRevision: before.page.revision, expectedVersion: before.version,
  });

  // Assert: встраивание по-прежнему указывает на ту же скрытую диаграмму.
  assert.equal(result.document?.source, '![](../Private/Map.drawio)\n');
  assert.equal(result.document?.assets[0]?.source, '<mxfile/>');
});

test('удаление заметки сохраняет диаграмму, которую встраивает скрытая заметка', t => {
  // Arrange: видимая и скрытая заметки встраивают одну диаграмму.
  const { open, put, root } = fixture(t);
  put(rules, 'Private\n');
  put('Map.drawio', '<mxfile/>');
  put('Private/Note.md', '![](../Map.drawio)');
  put('Visible.md', '![](Map.drawio)');
  const store = open();
  const visible = store.document('Visible.md');

  // Act: удаляем видимую заметку.
  store.deletePage(visible.path, visible.page.revision);

  // Assert: заметка исчезла, но общая диаграмма осталась.
  assert.equal(existsSync(join(root, visible.path)), false);
  assert.equal(readFileSync(join(root, 'Map.drawio'), 'utf8'), '<mxfile/>');
});

test('правила блокируют запись и перенос в скрытые пути до изменения файлов', t => {
  // Arrange: правило скрывает существующую папку и резервирует путь будущей папки.
  const { open, put, root } = fixture(t);
  put(rules, 'Private\nTarget/child\n');
  put('Private/Map.drawio', '<mxfile/>');
  put('Visible.md', '![](Private/Map.drawio)');
  put('Source/child/Note.md', 'keep');
  const store = open();
  const before = store.document('Visible.md');
  const expected = { expectedRevision: before.page.revision, expectedVersion: before.version };
  const { treeVersion } = store.snapshot();

  // Act и Assert: каждый запрос отклонён, исходные файлы сохранены.
  assert.throws(() => store.createPage('New', { path: 'Private/New.md' }), InvalidRequestError);
  assert.throws(() => store.createFolder('Private/New', treeVersion), InvalidRequestError);
  assert.throws(() => store.move(before.path, { ...expected, path: 'Private/Visible.md' }), InvalidRequestError);
  assert.throws(() => store.moveFolder('Source', 'Target', treeVersion), InvalidRequestError);
  assert.throws(() => store.prepare(before.path, {
    ...expected, source: before.source, assets: [{ path: 'Private/Map.drawio', source: '<changed/>', expectedVersion: before.assets[0]?.version ?? null }],
  }), InvalidRequestError);
  assert.equal(readFileSync(join(root, before.path), 'utf8'), before.source);
  assert.equal(readFileSync(join(root, 'Private/Map.drawio'), 'utf8'), '<mxfile/>');
  assert.equal(readFileSync(join(root, 'Source/child/Note.md'), 'utf8'), 'keep');
  assert.equal(existsSync(join(root, 'Target')), false);
  assert.equal(existsSync(join(root, 'Private/New.md')), false);
  assert.equal(existsSync(join(root, 'Private/New')), false);
});

for (const move of [false, true]) {
  test(`видимую папку со скрытым потомком нельзя ${move ? 'перенести' : 'удалить'}`, t => {
    // Arrange: в папке есть видимая заметка и скрытый подкаталог.
    const { open, put, root } = fixture(t);
    put(rules, 'Parent/Private\n');
    put('Parent/Visible.md', 'visible');
    put('Parent/Private/Note.md', 'hidden');
    const store = open();
    const { treeVersion } = store.snapshot();

    // Act: пробуем изменить папку целиком.
    const change = () => move ? store.moveFolder('Parent', 'Moved', treeVersion) : store.deleteFolder('Parent', treeVersion, true);

    // Assert: отказ не меняет ни одной части дерева.
    assert.throws(change, InvalidRequestError);
    assert.equal(readFileSync(join(root, 'Parent/Visible.md'), 'utf8'), 'visible');
    assert.equal(readFileSync(join(root, 'Parent/Private/Note.md'), 'utf8'), 'hidden');
    assert.equal(existsSync(join(root, 'Moved')), false);
  });
}
