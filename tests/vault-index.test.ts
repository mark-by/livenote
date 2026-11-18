import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { VaultStore } from '../src/server/vault.js';
import { VaultFiles } from '../src/server/vaultFiles.js';
import { vaultCachePath, vaultIdForRoot } from '../src/server/vaultIdentity.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'livenote-index-'));
  const root = join(directory, 'vault');
  mkdirSync(root);
  const cacheHome = join(directory, 'cache');
  const cachePath = vaultCachePath(realpathSync(root), cacheHome);
  const stores: VaultStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    root, cachePath, cacheHome,
    open(persistent = true) {
      const store = new VaultStore(root, undefined, persistent ? { cachePath } : undefined);
      stores.push(store);
      return store;
    },
  };
}

function bodyReads(t: TestContext) {
  const read = t.mock.method(VaultFiles.prototype, 'readBytes');
  return () => read.mock.calls.map(call => call.arguments[0]).filter(path => !path.startsWith('.livenote/'));
}

test('индекс использует UUID канонического пути и заданный каталог', t => {
  // Arrange: создаём два разных канонических пути.
  const { root, cacheHome } = fixture(t);
  const first = realpathSync(root);
  const sibling = join(first, 'another');
  mkdirSync(sibling);

  // Act: получаем ключ и пути индекса.
  const id = vaultIdForRoot(first);

  // Assert: ключ стабилен, а разные корни получают разные ключи.
  assert.match(id, /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.equal(vaultIdForRoot(first), id);
  assert.notEqual(vaultIdForRoot(realpathSync(sibling)), id);
  assert.equal(vaultCachePath(first, cacheHome), join(cacheHome, id, 'index.sqlite'));
  assert.equal(vaultCachePath(first), join(homedir(), '.livenote', id, 'index.sqlite'));
});

test('чтение и повторное открытие Vault обходятся без чтения неизменившихся файлов', t => {
  // Arrange: индексируем заметку с BOM и CRLF, диаграмму и двоичный файл.
  const { root, cachePath, open } = fixture(t);
  const source = '\uFEFF# Ёж\r\n\r\n![схема](Map.drawio)\r\n';
  const attachment = Buffer.from([0, 0xff, 13, 10]);
  writeFileSync(join(root, 'Note.md'), source);
  writeFileSync(join(root, 'Map.drawio'), '<mxfile/>\r\n');
  writeFileSync(join(root, 'data.bin'), attachment);
  const store = open();
  const coldTree = store.snapshot().treeVersion;
  const coldDocument = structuredClone(store.document('Note.md'));
  const reads = bodyReads(t);

  // Act: выполняем опрос и запросы, затем повторно открываем Vault.
  store.reconcile();
  assert.equal(store.search('Ёж')[0]?.pageId, 'Note.md');
  assert.equal(store.snapshot().treeVersion, coldTree);
  store.close();
  const reopened = open();
  const warmDocument = reopened.document('Note.md');
  const warmTree = reopened.snapshot().treeVersion;

  // Assert: индекс восстанавливает ту же проекцию без чтения содержимого файлов.
  assert.deepEqual(reads(), []);
  assert.ok(existsSync(cachePath));
  assert.deepEqual(warmDocument, coldDocument);
  assert.equal(warmTree, coldTree);
  assert.deepEqual(readFileSync(join(root, 'Note.md')), Buffer.from(source));
  assert.deepEqual(readFileSync(join(root, 'data.bin')), attachment);
});

test('замена диаграммы с прежним размером и mtime обновляет зависимые заметки', t => {
  // Arrange: две заметки используют одну диаграмму.
  const { root, open } = fixture(t);
  const asset = join(root, 'Map.drawio');
  const preservedTime = 1_700_000_000;
  writeFileSync(asset, '<old/>');
  utimesSync(asset, preservedTime, preservedTime);
  const oldStat = statSync(asset, { bigint: true });
  for (const note of ['One.md', 'Two.md']) writeFileSync(join(root, note), '![](Map.drawio)');
  const store = open(false);
  const before = store.document('One.md').version;
  const tree = store.snapshot().treeVersion;
  const reads = bodyReads(t);

  // Act: заменяем inode без изменения размера или mtime и запрашиваем заметки.
  const replacement = join(root, 'replacement');
  writeFileSync(replacement, '<new/>');
  utimesSync(replacement, preservedTime, preservedTime);
  renameSync(replacement, asset);
  const newStat = statSync(asset, { bigint: true });
  const one = store.document('One.md');
  const two = store.document('Two.md');

  // Assert: обе заметки используют новые байты; Vault читает диаграмму один раз.
  assert.equal(newStat.mtimeNs, oldStat.mtimeNs);
  assert.equal(newStat.size, oldStat.size);
  assert.notEqual(newStat.ino, oldStat.ino);
  assert.deepEqual([one.assets[0]?.source, two.assets[0]?.source], ['<new/>', '<new/>']);
  assert.notEqual(one.version, before);
  assert.notEqual(store.snapshot().treeVersion, tree);
  assert.deepEqual(reads(), ['Map.drawio']);
});

test('создание, переименование и удаление цели обновляют прямые и обратные ссылки', t => {
  // Arrange: заметка содержит две ссылки на один псевдоним.
  const { root, open } = fixture(t);
  writeFileSync(join(root, 'Source.md'), '[[Alias]] и [[Alias|другая подпись]]');
  const store = open();
  const reads = bodyReads(t);

  // Act: создаём, переименовываем и удаляем цель вне LiveNote.
  const targets = () => store.document('Source.md').links.map(link => link.targetPageId);
  const backlinks = (path: string) => store.document(path).backlinks.map(link => link.path);
  const missing = targets();
  writeFileSync(join(root, 'Old.md'), '---\naliases: [Alias]\n---\n');
  const added = [targets(), backlinks('Old.md')];
  renameSync(join(root, 'Old.md'), join(root, 'New.md'));
  const renamed = [targets(), backlinks('New.md')];
  unlinkSync(join(root, 'New.md'));
  const removed = targets();

  // Assert: цель меняет путь, обратная ссылка одна, источник не читается повторно.
  assert.deepEqual(missing, [null, null]);
  assert.deepEqual(added, [['Old.md', 'Old.md'], ['Source.md']]);
  assert.deepEqual(renamed, [['New.md', 'New.md'], ['Source.md']]);
  assert.deepEqual(removed, [null, null]);
  assert.equal(store.getPage('Old.md'), undefined);
  assert.equal(store.getPage('New.md'), undefined);
  assert.deepEqual(reads(), ['Old.md', 'New.md']);
});

test('Vault не создаёт постоянный индекс внутри выбранного дерева', t => {
  // Arrange: имитируем HOME внутри выбранного дерева.
  const { root } = fixture(t);
  const cacheHome = join(root, 'home', '.livenote');
  const cachePath = vaultCachePath(realpathSync(root), cacheHome);
  writeFileSync(join(root, 'Note.md'), 'Текст');

  // Act: открываем Vault с путём индекса внутри него.
  const store = new VaultStore(root, undefined, { cachePath });
  t.after(() => store.close());

  // Assert: заметку можно читать, а каталог индекса не появляется.
  assert.equal(store.document('Note.md').source, 'Текст');
  assert.equal(existsSync(cacheHome), false);
});

test('удаление диаграммы убирает цель ссылки и сохраняет блок с диагностикой', t => {
  // Arrange: заметка содержит встроенную диаграмму.
  const { root, open } = fixture(t);
  writeFileSync(join(root, 'Note.md'), '![схема](Map.drawio)');
  writeFileSync(join(root, 'Map.drawio'), '<mxfile/>');
  const store = open();
  const reads = bodyReads(t);

  // Act: удаляем диаграмму вне LiveNote.
  unlinkSync(join(root, 'Map.drawio'));

  // Assert: проекция сохраняет место диаграммы и сообщает об отсутствии файла.
  const note = store.document('Note.md');
  assert.equal(note.assets[0]?.source, null);
  assert.equal(note.links[0]?.targetPageId, null);
  assert.deepEqual(store.snapshot().problems.map(p => [p.code, p.path]), [['missing_asset', 'Map.drawio']]);
  assert.equal(store.getPage('Map.drawio'), undefined);
  assert.deepEqual(reads(), []);
});

test('ошибка чтения изменённого файла не возвращает устаревший документ из индекса', t => {
  // Arrange: индексируем заметку и моделируем отказ чтения на уровне файлов.
  const { root, open } = fixture(t);
  const path = 'Note.md';
  writeFileSync(join(root, path), 'Старый текст');
  const store = open();
  const readBytes = VaultFiles.prototype.readBytes;
  t.mock.method(VaultFiles.prototype, 'readBytes', function (this: VaultFiles, name: string) {
    if (name === path) throw Object.assign(new Error('Чтение запрещено'), { code: 'EACCES' });
    return readBytes.call(this, name);
  });

  // Act: меняем файл, чтобы индекс проверил его содержимое.
  writeFileSync(join(root, path), 'Новый текст, недоступный для чтения');
  const snapshot = store.snapshot();

  // Assert: Vault исключает документ из списка и сообщает об ошибке.
  assert.deepEqual(snapshot.pages, []);
  assert.deepEqual(snapshot.problems.map(problem => [problem.path, problem.code]), [[path, 'unreadable_file']]);
});

for (const scenario of [
  { name: 'перед запуском', runtime: false, breakIndex: (path: string) => writeFileSync(path, 'не SQLite') },
  { name: 'во время работы', runtime: true, breakIndex(path: string) {
    const db = new Database(path);
    try { db.exec('DROP TABLE files'); }
    finally { db.close(); }
  } },
]) {
  test(`Vault восстанавливает повреждённый индекс ${scenario.name}`, t => {
    // Arrange: создаём индекс и повреждаем его в выбранный момент.
    const { root, cachePath, open } = fixture(t);
    const source = '# Канонический текст\r\n';
    writeFileSync(join(root, 'Note.md'), source);
    const store = open();
    if (!scenario.runtime) store.close();
    scenario.breakIndex(cachePath);

    // Act: запрашиваем заметку через проекцию.
    const active = scenario.runtime ? store : open();
    assert.equal(active.document('Note.md').source, source);
    active.close();

    // Assert: новый индекс выдерживает повторный запуск без чтения заметки.
    const reads = bodyReads(t);
    assert.equal(open().document('Note.md').source, source);
    assert.deepEqual(reads(), []);
  });
}

test('отменённая транзакция не сохраняет подготовленный документ в SQLite', t => {
  // Arrange: создаём индекс и запоминаем его байты.
  const { cachePath, open } = fixture(t);
  const store = open();
  const before = readFileSync(cachePath);
  const abort = new Error('Отменить транзакцию');

  // Act: прерываем транзакцию после появления заметки в её проекции.
  assert.throws(() => store.atomic('failed', {}, () => {
    store.createPage('Draft', { source: 'Подготовленный текст' });
    assert.equal(store.document('Draft.md').source, 'Подготовленный текст');
    assert.deepEqual(readFileSync(cachePath), before);
    throw abort;
  }), abort);

  // Assert: после отката SQLite и проекция не содержат подготовленную запись.
  assert.deepEqual(readFileSync(cachePath), before);
  assert.equal(store.getPage('Draft.md'), undefined);
});
