import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { createApp, type RunningApp } from '../src/server/app.js';
import { parseConfig } from '../src/server/config.js';
import { LIVENOTE_VERSION } from '../src/shared/types.js';
import type { ChooseFolder } from '../src/server/vaultPicker.js';
import { vaultIdForRoot } from '../src/server/vaultIdentity.js';
import { VaultRegistry } from '../src/server/vaultRegistry.js';
import type { DiagramValidation } from '../src/shared/types.js';

const timeout = 10_000;
const grace = 100;
const token = 'vault-runtime-test-token';
const openPath = '/api/vaults/open';
const vaultScope = (id: string) => `/api/vaults/${id}`;
const ssePath = (id: string) => `/events?vault_id=${encodeURIComponent(id)}`;
const vaultResult = z.object({ vault: z.object({ id: z.string(), name: z.string() }) });
const pageList = z.object({ pages: z.array(z.object({ id: z.string() })) });
const eventPage = z.object({ pageId: z.string() });

async function fixture(t: TestContext, choose: (selected: string) => ChooseFolder, legacy = false) {
  const home = mkdtempSync(join(tmpdir(), 'livenote-runtime-'));
  const selected = join(home, 'selected');
  const startup = join(home, 'startup');
  mkdirSync(selected);
  const cacheHome = join(home, 'cache');
  const server = createServer();
  let running: RunningApp | undefined;
  t.after(async () => {
    try {
      await running?.close();
    } finally {
      if (server.listening) {
        const closed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await closed;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const selection = parseConfig(legacy ? ['--db', 'legacy.sqlite'] : [], { LIVENOTE_PORT: String(port), LIVENOTE_TOKEN: token }, legacy ? home : startup);
  assert.equal(selection.command, 'serve');
  running = await createApp(selection.config, {
    chooseFolder: choose(selected), closeGraceMs: grace, cacheHome
  });
  server.on('request', running.app);
  const base = `http://127.0.0.1:${port}`;
  const startupId = legacy ? undefined : vaultIdForRoot(realpathSync.native(startup));

  function request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(base + path, {
      signal: AbortSignal.timeout(timeout),
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers }
    });
  }

  function post(path: string, body: object = {}, extra: Record<string, string> = {}): Promise<Response> {
    return request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...extra } });
  }

  async function openSelected() {
    const response = await post(openPath);
    assert.equal(response.status, 200);
    return vaultResult.parse(await response.json()).vault;
  }

  async function stream(path: string) {
    const disconnected = new Promise<void>(resolve => {
      server.prependOnceListener('request', (_req, response) => response.once('close', resolve));
    });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      get(base + path, { headers: { authorization: `Bearer ${token}` }, signal }, resolve).on('error', reject);
    });
    assert.equal(response.statusCode, 200);
    const lines = createInterface({ input: response })[Symbol.asyncIterator]();
    async function nextEvent() {
      let event = '';
      for (;;) {
        const line = await lines.next();
        if (line.done) return null;
        if (line.value.startsWith('event: ')) event = line.value.slice(7);
        if (line.value.startsWith('data: ')) {
          const data: unknown = JSON.parse(line.value.slice(6));
          return { event, data };
        }
      }
    }
    assert.equal((await nextEvent())?.event, 'hello');
    return { nextEvent, disconnect: async () => { controller.abort(); await disconnected; } };
  }

  return { home, startup, startupId, selected, running, request, post, openSelected, stream };
}

test('выбранный vault без вкладок закрывается, стартовый остаётся открыт до shutdown', { timeout }, async t => {
  // Arrange: открывает выбранный vault и оставляет оба vault без SSE.
  const f = await fixture(t, path => async () => path);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { id } = await f.openSelected();
  assert.deepEqual(await (await f.request('/api/config')).json(), {
    version: LIVENOTE_VERSION, storage: 'vault', tokenRequired: true, mermaidTheme: 'default',
    folderPickerAvailable: true, defaultVaultId: f.startupId
  });

  // Act: пропускает срок подключения первой вкладки.
  t.mock.timers.tick(grace);

  // Assert: выбранный vault больше недоступен; стартовый сохраняет lock до shutdown.
  const expired = await f.request(`${vaultScope(id)}/vault`);
  assert.equal(expired.status, 404);
  assert.equal((await expired.json()).error.code, 'vault_not_found');
  assert.equal((await f.request('/api/vault')).status, 200);
  const startupLock = join(f.startup, '.livenote/lock');
  assert.equal(existsSync(startupLock), true);
  await f.running.close();
  assert.equal(existsSync(startupLock), false);
});

test('последняя SSE-вкладка запускает отсчёт, а переподключение отменяет его', { timeout }, async t => {
  // Arrange: подключает две вкладки к одному выбранному vault.
  const f = await fixture(t, path => async () => path);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { id } = await f.openSelected();
  const first = await f.stream(ssePath(id));
  const second = await f.stream(ssePath(id));
  const scope = `${vaultScope(id)}/vault`;

  // Act: отключает вкладки по очереди и успевает переподключиться до истечения срока.
  await first.disconnect();
  t.mock.timers.tick(grace);
  assert.equal((await f.request(scope)).status, 200);
  await second.disconnect();
  t.mock.timers.tick(grace - 1);
  const reconnected = await f.stream(ssePath(id));
  t.mock.timers.tick(grace);
  assert.equal((await f.request(scope)).status, 200);

  // Assert: последнее отключение закрывает vault через полный интервал.
  await reconnected.disconnect();
  t.mock.timers.tick(grace);
  assert.equal((await f.request(ssePath(id))).status, 404);
  assert.equal(existsSync(join(f.selected, '.livenote/lock')), false);
  assert.equal((await f.openSelected()).id, id);
});

test('два пути к одному каталогу возвращают один дескриптор', { timeout }, async t => {
  // Arrange: первый выбор возвращает каталог, второй выбор возвращает символическую ссылку на него.
  let picked = false;
  const f = await fixture(t, path => {
    const alias = join(path, '..', 'alias');
    symlinkSync(path, alias, 'dir');
    return async () => {
      if (picked) return alias;
      picked = true;
      return path;
    };
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const direct = await f.openSelected();
  // Act: открывает тот же vault через ссылку, пока он ещё открыт.
  const alias = await f.openSelected();
  // Assert: API не раскрывает путь и сохраняет канонический ID.
  assert.deepEqual(alias, direct);
  assert.equal(alias.name, 'selected');
});

test('scoped REST и SSE не смешивают выбранный и стартовый vault', { timeout }, async t => {
  // Arrange: подписывается на оба vault, используя старый URL для стартового.
  const f = await fixture(t, path => async () => path);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { id } = await f.openSelected();
  const selected = await f.stream(ssePath(id));
  const startup = await f.stream('/events');
  const selectedPages = `${vaultScope(id)}/pages`;

  // Act: создаёт страницу с отличимым путём и заголовком в каждом vault.
  assert.equal((await f.post(selectedPages, { title: 'Выбранная', path: 'Note.md' })).status, 200);
  assert.equal((await f.post('/api/pages', { title: 'Стартовая', path: 'Home.md' })).status, 200);

  // Assert: списки страниц и первые события содержат только данные своего vault.
  assert.deepEqual(pageList.parse(await (await f.request(selectedPages)).json()).pages, [{ id: 'Note.md' }]);
  assert.deepEqual(pageList.parse(await (await f.request('/api/pages')).json()).pages, [{ id: 'Home.md' }]);
  assert.equal(eventPage.parse((await selected.nextEvent())?.data).pageId, 'Note.md');
  assert.equal(eventPage.parse((await startup.nextEvent())?.data).pageId, 'Home.md');
  await f.running.close();
  assert.equal(await startup.nextEvent(), null);
  assert.equal(await selected.nextEvent(), null);
});

test('отмена picker возвращает null и не открывает vault', { timeout }, async t => {
  // Arrange: заменяет системный диалог ответом «отмена».
  const f = await fixture(t, () => async () => null);
  // Act: отправляет допустимый запрос на открытие.
  const response = await f.post(openPath);
  // Assert: отмена не считается ошибкой или выбором каталога.
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { vault: null });
});

test('shutdown отменяет активный picker, второй запрос получает 409', { timeout }, async t => {
  // Arrange: первый диалог остаётся открыт до отмены сервером.
  const opened = new EventTarget();
  const f = await fixture(t, path => async signal => {
    const aborted = once(signal, 'abort');
    opened.dispatchEvent(new Event('open'));
    await aborted;
    return path;
  });
  const pickerOpened = once(opened, 'open');
  const pending = f.post(openPath);
  await pickerOpened;
  const busy = await f.post(openPath);

  // Act: завершает работу сервера при незакрытом диалоге.
  await f.running.close();

  // Assert: второй запрос не запускает диалог, а результат отменённого выбора не открывает vault.
  assert.equal(busy.status, 409);
  assert.equal((await pending).status, 503);
  assert.equal(existsSync(join(f.selected, '.livenote/lock')), false);
});

test('shutdown ждёт записи, пока проверка диаграммы не закончилась', { timeout }, async t => {
  // Arrange: запускает запись, которая ждёт результата внешнего валидатора.
  const directory = mkdtempSync(join(tmpdir(), 'livenote-runtime-drain-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const selection = parseConfig([], {}, join(directory, 'vault'));
  assert.equal(selection.command, 'serve');
  const state = new EventTarget();
  const checked = once(state, 'valid');
  const result: DiagramValidation = { syntax: 'ok', renderer: 'unavailable' };
  const validator = {
    kind: 'unavailable' as const,
    parse: async () => {
      state.dispatchEvent(new Event('checking'));
      await checked;
      return result;
    },
    render: async () => ({ validation: result }),
    layout: async () => ({ ok: false })
  };
  const registry = new VaultRegistry({
    config: selection.config, cacheHome: join(directory, 'cache'),
    validators: { mermaid: validator, drawio: validator, bpmn: validator }
  });
  const { descriptor } = registry.openStartup(join(directory, 'vault'));
  const checking = once(state, 'checking');
  const path = 'Flow.mmd';
  const write = registry.resolve(descriptor.id).service.createDocument({ title: 'Flow', path, source: 'flowchart LR\nA --> B' });
  await checking;

  // Act: вызывает shutdown до завершения проверки.
  const closed = registry.close();
  const lockHeld = existsSync(join(directory, 'vault/.livenote/lock'));
  state.dispatchEvent(new Event('valid'));

  // Assert: запись завершилась до освобождения файловой блокировки.
  assert.equal((await write).id, path);
  await closed;
  assert.equal(lockHeld, true);
  assert.equal(existsSync(join(directory, 'vault', path)), true);
  assert.equal(existsSync(join(directory, 'vault/.livenote/lock')), false);
});

test('picker отклоняет запросы без bearer, с другого origin и с путём', { timeout }, async t => {
  // Arrange: диалог не должен запускаться при нарушении любого условия.
  const f = await fixture(t, () => async () => assert.fail('Некорректный запрос запустил picker'));
  // Act и Assert: проверяет авторизацию, происхождение, тело и query независимо.
  assert.equal((await f.post(openPath, {}, { authorization: '' })).status, 401);
  assert.equal((await f.post(openPath, {}, { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await f.post(openPath, { path: f.selected })).status, 400);
  assert.equal((await f.post(`${openPath}?path=${encodeURIComponent(f.selected)}`)).status, 400);
});

test('явный --db сохраняет SQLite API без системного picker', { timeout }, async t => {
  // Arrange: запускает сервер с явным --db.
  const f = await fixture(t, () => async () => assert.fail('SQLite запустил picker'), true);
  // Act: обращается к старому API и к API выбора vault.
  const config = await (await f.request('/api/config')).json();
  const response = await f.post('/api/pages', { title: 'SQLite' });
  // Assert: SQLite отвечает без идентификатора vault и не принимает scoped-запросы.
  assert.equal(config.storage, 'sqlite');
  assert.equal(config.defaultVaultId, undefined);
  assert.equal(config.folderPickerAvailable, false);
  assert.equal(response.status, 200);
  assert.equal((await f.post(openPath)).status, 404);
  assert.equal((await f.request(ssePath('unknown'))).status, 404);
});
