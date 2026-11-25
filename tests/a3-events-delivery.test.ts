import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { connectEvents } from '../src/web/events.ts';
import { connectVaultEvents } from '../src/web/vault/vaultEvents.ts';
import type { EventHandlers } from '../src/web/events.ts';

class TestPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  receive(name: string, data?: string): void {
    this.onmessage?.(new MessageEvent('message', { data: { name, data } }));
  }
}

class TestWorker {
  static instances: TestWorker[] = [];
  port = new TestPort();

  constructor() {
    TestWorker.instances.push(this);
  }
}

function setupEvents(t: TestContext): { window: EventTarget; close: (connection: { close(): void }) => void } {
  const window = new EventTarget();
  const globals = { window, SharedWorker: TestWorker, localStorage: { getItem: () => 'a b' } };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let connection: { close(): void } | undefined;
  t.after(() => {
    connection?.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  TestWorker.instances = [];
  return { window, close: (value) => { connection = value; } };
}

const variants = [
  { name: 'обычный канал', connect: (handlers: EventHandlers) => connectEvents(handlers), url: '/events?token=a%20b' },
  { name: 'канал Vault', connect: (handlers: EventHandlers) => connectVaultEvents(handlers, 'vault/one'), url: '/events?vault_id=vault%2Fone&token=a+b' }
];

for (const variant of variants) {
  test(`events: ${variant.name}, исключение hello не вызывает повторную доставку`, (t) => {
    // Arrange: обработчик сообщает об ошибке после получения корректного JSON.
    const fixture = setupEvents(t);
    const received: unknown[] = [];
    const error = new Error('handler failed');
    const connection = variant.connect({ onHello: (value) => { received.push(value); throw error; } });
    fixture.close(connection);
    const worker = TestWorker.instances[0];
    assert.ok(worker);

    // Act и Assert: ошибка обработчика сохраняется, повторного вызова нет.
    assert.throws(() => worker.port.receive('hello', '{"ready":true}'), (actual) => actual === error);
    assert.deepEqual(received, [{ ready: true }]);
  });

  test(`events: ${variant.name}, повреждённый JSON не прерывает поток`, (t) => {
    // Arrange: обработчики записывают доставленные данные.
    const fixture = setupEvents(t);
    const hello: unknown[] = [];
    const pages: unknown[] = [];
    const connection = variant.connect({ onHello: (value) => hello.push(value), onPageUpdated: (value) => pages.push(value) });
    fixture.close(connection);
    const worker = TestWorker.instances[0];
    assert.ok(worker);

    // Act: отправляем повреждённые сообщения, затем корректное событие.
    worker.port.receive('hello', '{');
    worker.port.receive('page.updated', '{');
    worker.port.receive('page.updated', '{"pageId":"isolated"}');

    // Assert: приветствие получает undefined, а повреждённое событие пропущено.
    assert.deepEqual(hello, [undefined]);
    assert.deepEqual(pages, [{ pageId: 'isolated' }]);
  });

  test(`events: ${variant.name}, ошибка события доступна вызывающей стороне`, (t) => {
    // Arrange: обработчик события выбрасывает известную ошибку.
    const fixture = setupEvents(t);
    const error = new Error('event handler failed');
    const connection = variant.connect({ onPageUpdated: () => { throw error; } });
    fixture.close(connection);
    const worker = TestWorker.instances[0];
    assert.ok(worker);

    // Act и Assert: ошибка не принимается за ошибку JSON.
    assert.throws(() => worker.port.receive('page.updated', '{}'), (actual) => actual === error);
  });

  test(`events: ${variant.name}, повторное подключение и закрытие порта`, (t) => {
    // Arrange: канал открывает порт с параметрами своего хранилища.
    const fixture = setupEvents(t);
    const { window } = fixture;
    const connection = variant.connect({});
    fixture.close(connection);
    const first = TestWorker.instances[0];
    assert.ok(first);
    assert.deepEqual(first.port.messages[0], {
      type: 'connect', url: variant.url,
      names: ['hello', 'page.created', 'page.updated', 'page.deleted', 'page.moved', 'vault.updated', 'block.created', 'block.updated', 'block.deleted']
    });

    // Act: страница скрывается и возвращается из кэша, затем соединение закрывается.
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
    const second = TestWorker.instances[1];
    assert.ok(second);
    connection.close();
    window.dispatchEvent(new Event('pageshow'));

    // Assert: оба порта отключены и после закрытия новые порты не создаются.
    assert.equal(first.port.onmessage, null);
    assert.deepEqual(first.port.messages.at(-1), { type: 'disconnect' });
    assert.equal(second.port.onmessage, null);
    assert.deepEqual(second.port.messages.at(-1), { type: 'disconnect' });
    assert.equal(TestWorker.instances.length, 2);
  });
}

test('events: браузер доставляет SSE после ошибки обработчика и повреждённого JSON', { timeout: 30_000 }, async (t) => {
  // Arrange: отдельный сервер отдаёт сообщения через настоящий SharedWorker.
  const cacheDir = await mkdtemp(join(tmpdir(), 'livenote-a3-events-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  t.after(async () => {
    await browser?.close();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    }
    await vite?.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  vite = await createViteServer({ configFile: false, root: process.cwd(), cacheDir, server: { middlewareMode: true } });
  const middleware = vite.middlewares;
  server = createHttpServer((request, response) => {
    if (request.url?.startsWith('/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write('event: hello\ndata: {"ready":true}\n\nevent: hello\ndata: {\n\nevent: page.updated\ndata: {\n\nevent: page.updated\ndata: {"pageId":"temporary"}\n\n');
      return;
    }
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>events</title>');
      return;
    }
    middleware(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let finish: (value: { hello: unknown[]; pages: unknown[] }) => void = () => {};
  const received = new Promise<{ hello: unknown[]; pages: unknown[] }>((resolve) => { finish = resolve; });
  await page.exposeFunction('eventsFinished', finish);
  await page.goto(`http://127.0.0.1:${address.port}/`);

  // Act: подписка получает сообщения от тестового SSE-сервера.
  await page.evaluate(`(async () => {
    const { connectEvents } = await import('/src/web/events.ts');
    const hello = [];
    const pages = [];
    const connection = connectEvents({
      onHello: (value) => {
        hello.push(value ?? null);
        if (value !== undefined) throw new Error('events handler failed');
      },
      onPageUpdated: (value) => {
        pages.push(value);
        connection.close();
        window.eventsFinished({ hello, pages });
      }
    });
  })()`);

  // Assert: ошибка видна браузеру, поток продолжает доставку.
  assert.deepEqual(await received, { hello: [{ ready: true }, null], pages: [{ pageId: 'temporary' }] });
  assert.deepEqual(errors, ['events handler failed']);
});
