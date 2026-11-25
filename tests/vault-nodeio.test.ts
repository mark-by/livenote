import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs, { type WatchListener, type WatchOptions } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AppError } from '../src/server/errors.js';
import { VaultStore } from '../src/server/vault.js';
import type { LiveEvent } from '../src/shared/types.js';

const timeout = 10_000;

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'livenote-nodeio-')));
  const put = (path: string, source: string) => fs.writeFileSync(join(root, path), source);
  let store: VaultStore | undefined;
  t.after(() => {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, put, open: (publish?: (event: LiveEvent) => void) =>
    store = new VaultStore(root, publish === undefined ? undefined : { publish }) };
}

function filesystemCounts(t: TestContext) {
  const readdir = t.mock.method(fs, 'readdirSync');
  const lstat = t.mock.method(fs, 'lstatSync');
  syncBuiltinESMExports();
  t.after(() => { readdir.mock.restore(); lstat.mock.restore(); syncBuiltinESMExports(); });
  return (root: string) => {
    const inside = (path: unknown) => typeof path === 'string' && (path === root || path.startsWith(root + sep));
    return {
      readdirSync: readdir.mock.calls.filter(call => inside(call.arguments[0])).length,
      lstatSync: lstat.mock.calls.filter(call => inside(call.arguments[0])).length,
    };
  };
}

function externalUpdate(open: ReturnType<typeof fixture>['open'], path: string) {
  const emitter = new EventEmitter<{ update: [LiveEvent] }>();
  const event = new Promise<LiveEvent>(resolve => emitter.once('update', resolve));
  const store = open(event => {
    if (event.pageId === path) emitter.emit('update', event);
  });
  return { store, event };
}

function controlWatch(t: TestContext) {
  const watch = fs.watch;
  const events = new EventEmitter<{ change: ['rename', string] }>();
  const controlled = t.mock.method(fs, 'watch', (path: string, options: WatchOptions, listener: WatchListener<string>) => {
    events.on('change', listener);
    return watch(path, { recursive: options.recursive });
  });
  syncBuiltinESMExports();
  t.after(() => { controlled.mock.restore(); syncBuiltinESMExports(); });
  return events;
}

test('F1 nodeio: чтения одной заметки не обходят дерево', t => {
  // Arrange: прогреваем проекцию Vault с заметками в нескольких каталогах.
  const { root, put, open } = fixture(t);
  const note = 'Notes-0/Note-0.md';
  for (let dir = 0; dir < 20; dir++) {
    fs.mkdirSync(join(root, `Notes-${dir}`));
    for (let file = 0; file < 20; file++) put(`Notes-${dir}/Note-${file}.md`, 'текст заметки');
  }
  const store = open();
  const readCount = 100;
  const counts = filesystemCounts(t);

  // Act: читаем одну заметку без записей и событий файловой системы.
  const samples = Array.from({ length: readCount }, () => {
    const start = performance.now();
    const { source } = store.document(note);
    return { source, elapsed: performance.now() - start };
  });

  // Assert: чтение не перечисляет каталоги и не проверяет соседние файлы.
  const timings = samples.map(sample => sample.elapsed).sort((a, b) => a - b);
  const observed = counts(root);
  const p95 = timings[Math.ceil(readCount * 0.95) - 1];
  t.diagnostic(JSON.stringify({ readCount, files: 400, ...observed, p95Ms: p95 }));
  assert.ok(samples.every(sample => sample.source === 'текст заметки'));
  assert.equal(observed.readdirSync, 0);
  assert.ok(observed.lstatSync <= 10 * readCount, 'проверки метаданных зависят только от пути заметки');
});

test('F1 nodeio: событие для известного файла обновляет поиск без обхода', { timeout }, async t => {
  // Arrange: управляем доставкой события, чтобы ОС не объединила его с изменением соседнего пути.
  const { root, put, open } = fixture(t);
  const note = 'Note.md';
  put(note, 'старый текст');
  const watcher = controlWatch(t);
  const { store, event } = externalUpdate(open, note);
  const counts = filesystemCounts(t);

  // Act: записываем настоящий файл и передаём событие с его именем.
  put(note, 'свежий текст');
  watcher.emit('change', 'rename', note);
  const update = await event;

  // Assert: наблюдатель обновил проекцию без перечисления каталогов.
  assert.equal(update.event, 'page.updated');
  assert.equal(update.origin, 'external');
  assert.equal(store.document(note).source, 'свежий текст');
  assert.deepEqual(store.search('свежий').map(hit => hit.path), [note]);
  const observed = counts(root);
  t.diagnostic(JSON.stringify(observed));
  assert.equal(observed.readdirSync, 0);
});

test('F1 nodeio: периодическая сверка находит пропущенное внешнее изменение', { timeout }, async t => {
  // Arrange: оставляем настоящий наблюдатель, но не передаём его события хранилищу.
  const { put, open } = fixture(t);
  const note = 'Missed.md';
  put(note, 'старый текст');
  controlWatch(t);
  const { store, event } = externalUpdate(open, note);

  // Act: меняем файл и ждём извещение от сверки, не запрашивая заметку.
  put(note, 'пропущенная правка');
  const update = await event;

  // Assert: сверка обновила проекцию и оповестила клиента.
  assert.equal(update.event, 'page.updated');
  assert.deepEqual(store.search('пропущенная').map(hit => hit.path), [note]);
});

test('F2 nodeio: число обходов при переносе не зависит от числа входящих ссылок', t => {
  // Arrange: каждый Vault имеет одинаковое дерево, но разное число входящих ссылок.
  const measurements = [1, 10, 100].map(incoming => {
    const { root, put, open } = fixture(t);
    const from = 'Target.md', to = 'Moved.md';
    put(from, 'цель');
    fs.mkdirSync(join(root, 'Sources'));
    const paths = Array.from({ length: 100 }, (_, i) => `Sources/Ref-${i}.md`);
    paths.forEach((path, i) => put(path, i < incoming ? '[цель](../Target.md)' : 'нет ссылки'));
    const store = open();
    const { version, page } = store.document(from);
    return { incoming, root, store, from, to, paths, version, page };
  });
  const counts = filesystemCounts(t);

  const observed = measurements.map(({ incoming, root, store, from, to, paths, version, page }) => {
    // Act: перемещаем цель и считаем синхронные перечисления каталогов.
    const moved = store.move(from, { path: to, expectedRevision: page.revision, expectedVersion: version });
    const count = counts(root);

    // Assert: переписаны все входящие ссылки, остальные файлы не изменены.
    assert.equal(moved.document?.path, to);
    assert.equal(moved.updatedPaths.length, incoming + 1);
    assert.deepEqual(paths.map(path => fs.readFileSync(join(root, path), 'utf8')),
      paths.map((_, i) => i < incoming ? '[цель](../Moved.md)' : 'нет ссылки'));
    return { incoming, ...count };
  });
  t.diagnostic(JSON.stringify(observed));
  assert.equal(new Set(observed.map(item => item.readdirSync)).size, 1);
});

test('F2 nodeio: изменение входящей ссылки после планирования отменяет перенос', t => {
  // Arrange: внешний редактор меняет входящую ссылку прямо перед файловым CAS.
  const { root, put, open } = fixture(t);
  const from = 'Target.md', to = 'Moved.md', incoming = 'Ref.md';
  const unchanged = 'Other.md', link = '[цель](Target.md)', external = 'независимая правка';
  put(from, 'цель'); put(incoming, link); put(unchanged, link);
  const store = open();
  const { version, page } = store.document(from);
  const commit = store.files.commit.bind(store.files);
  t.mock.method(store.files, 'commit', (...args: Parameters<typeof commit>) => {
    put(incoming, external);
    return commit(...args);
  });

  // Act: пытаемся переместить цель.
  assert.throws(
    () => store.move(from, { path: to, expectedRevision: page.revision, expectedVersion: version }),
    error => error instanceof AppError && error.httpStatus === 409 && error.code === 'conflict' &&
      typeof error.details === 'object' && error.details !== null && 'reason' in error.details && error.details.reason === 'stale',
  );

  // Assert: ни перенос, ни переписывание ссылок не опубликованы.
  assert.equal(fs.existsSync(join(root, to)), false);
  assert.equal(fs.readFileSync(join(root, from), 'utf8'), 'цель');
  assert.equal(fs.readFileSync(join(root, incoming), 'utf8'), external);
  assert.equal(fs.readFileSync(join(root, unchanged), 'utf8'), link);
});

test('F2 nodeio: пакетная сверка отклоняет устаревший план даже с новыми ожидаемыми байтами', t => {
  // Arrange: меняем входящую ссылку, когда перенос собирает байты по старому графу.
  const { root, put, open } = fixture(t);
  const from = 'Target.md', to = 'Moved.md', incoming = 'Ref.md';
  const external = 'независимая правка';
  put(from, 'цель'); put(incoming, '[цель](Target.md)');
  const store = open();
  const { version, page } = store.document(from);
  const read = store.files.readBytes.bind(store.files);
  let changed = false;
  t.mock.method(store.files, 'readBytes', (path: string) => {
    if (path === incoming && !changed) { changed = true; put(incoming, external); }
    return read(path);
  });

  // Act: перенос строит запись с новыми ожидаемыми байтами, но проверяет прежнюю версию.
  assert.throws(() => store.move(from, { path: to, expectedRevision: page.revision, expectedVersion: version }),
    error => error instanceof AppError && error.httpStatus === 409 && error.code === 'conflict' &&
      typeof error.details === 'object' && error.details !== null && 'currentVersion' in error.details &&
      typeof error.details.currentVersion === 'string');

  // Assert: хранилище не применило устаревший план.
  assert.equal(fs.existsSync(join(root, to)), false);
  assert.equal(fs.readFileSync(join(root, from), 'utf8'), 'цель');
  assert.equal(fs.readFileSync(join(root, incoming), 'utf8'), external);
});
