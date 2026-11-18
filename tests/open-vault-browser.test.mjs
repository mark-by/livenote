import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium, expect } from 'playwright/test';

const distRoot = normalize(new URL('../dist/web', import.meta.url).pathname);
const vaults = {
  alpha: { id: 'alpha', name: 'Alpha', path: 'Alpha.md', title: 'Заметка Alpha' },
  beta: { id: 'beta', name: 'Beta', path: 'Beta.md', title: 'Заметка Beta' }
};
const state = {
  picker: async () => ({ vault: { id: 'beta', name: 'Beta' } }),
  pickerCalls: [],
  apiPaths: [],
  eventQueries: []
};
let server;
let browser;
let base;

function documentFor(vault) {
  const source = `# ${vault.title}\n`;
  return {
    page: {
      id: vault.path,
      title: vault.title,
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      blocks: [{
        id: 'span-0', pageId: vault.path, type: 'markdown', source, title: null, position: 0,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        renderedRevision: null, renderOk: null, renderError: null
      }]
    },
    path: vault.path,
    source,
    version: 'version-1',
    spans: [],
    aliases: [],
    tags: [],
    assets: [],
    links: [],
    backlinks: []
  };
}

function snapshotFor(vault) {
  const document = documentFor(vault);
  return {
    vaultName: vault.name,
    pages: [{ ...document.page, path: vault.path, aliases: [], tags: [] }],
    files: [{ path: vault.path, kind: 'markdown', title: vault.title, version: document.version, revision: 1 }],
    folders: ['', 'Раздел', 'Раздел/Подраздел'], treeVersion: 'tree-1', tags: [], problems: []
  };
}

function json(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text;
}

before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/events') {
      state.eventQueries.push(Object.fromEntries(url.searchParams));
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(': connected\n\n');
      request.on('close', () => response.end());
      return;
    }
    if (url.pathname === '/api/config') {
      json(response, { version: '0.1.0', tokenRequired: false, mermaidTheme: 'default', storage: 'vault', defaultVaultId: 'alpha', folderPickerAvailable: true });
      return;
    }
    if (url.pathname === '/api/vaults/open' && request.method === 'POST') {
      const body = await readBody(request);
      state.pickerCalls.push({ path: url.pathname, body });
      try {
        json(response, await state.picker());
      } catch (error) {
        json(response, { error: { code: 'picker_failed', message: error instanceof Error ? error.message : String(error) } }, 500);
      }
      return;
    }
    const scoped = url.pathname.match(/^\/api\/vaults\/([^/]+)(\/.*)$/);
    if (scoped) {
      const vaultId = decodeURIComponent(scoped[1]);
      const suffix = scoped[2];
      state.apiPaths.push({ vaultId, suffix, method: request.method });
      const vault = vaults[vaultId];
      if (!vault) {
        json(response, { error: { code: 'vault_unavailable', message: 'Хранилище закрыто' } }, 404);
        return;
      }
      if (suffix === '/vault') {
        json(response, snapshotFor(vault));
        return;
      }
      if (suffix === `/pages/${encodeURIComponent(vault.path)}/document`) {
        json(response, { document: documentFor(vault) });
        return;
      }
      if (suffix === '/search') {
        json(response, { hits: [] });
        return;
      }
      json(response, { error: { code: 'not_found', message: 'Не найдено' } }, 404);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      state.apiPaths.push({ vaultId: null, suffix: url.pathname, method: request.method });
      json(response, { error: { code: 'unscoped', message: 'Неожиданный запрос без vault' } }, 500);
      return;
    }
    try {
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const path = normalize(join(distRoot, relative));
      if (!path.startsWith(distRoot)) throw new Error('Недопустимый путь');
      const content = await readFile(path);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
      response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
});

async function openPage(context, vaultId = 'alpha') {
  const page = await context.newPage();
  await page.goto(vaultId === null ? base : `${base}/?vault_id=${vaultId}`);
  await expect(page.locator('.vault-app')).toBeVisible();
  return page;
}

async function chooseOpenFolder(page) {
  await page.getByRole('button', { name: 'Меню LiveNote' }).click();
  await page.getByRole('menuitem', { name: 'Открыть папку', exact: true }).click();
}

test('Default and explicit vaults keep REST, SSE and editor tabs isolated', { timeout: 90_000 }, async (t) => {
  // Arrange: две вкладки одного браузера открывают разные хранилища.
  const context = await browser.newContext();
  t.after(() => context.close());
  const alpha = await context.newPage();
  await alpha.goto(base);
  await expect(alpha.locator('.cm-content')).toContainText('Заметка Alpha');
  assert.equal(new URL(alpha.url()).searchParams.get('vault_id'), 'alpha');

  // Act: открываем второе хранилище и возвращаемся к первому.
  const beta = await openPage(context, 'beta');
  await expect(beta.locator('.cm-content')).toContainText('Заметка Beta');
  await expect(beta.locator('.cm-content')).not.toContainText('Заметка Alpha');
  await alpha.reload();
  await expect(alpha.locator('.cm-content')).toContainText('Заметка Alpha');

  // Assert: запросы, SSE и сохранённые вкладки имеют независимые области.
  assert.ok(state.apiPaths.some((item) => item.vaultId === 'alpha' && item.suffix === '/vault'));
  assert.ok(state.apiPaths.some((item) => item.vaultId === 'beta' && item.suffix === '/vault'));
  assert.equal(state.apiPaths.some((item) => item.vaultId === null), false);
  await expect.poll(() => state.eventQueries.some((query) => query.vault_id === 'alpha')).toBe(true);
  await expect.poll(() => state.eventQueries.some((query) => query.vault_id === 'beta')).toBe(true);
  const storage = await alpha.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('livenote_open_tabs')));
  assert.ok(storage.includes('livenote_open_tabs:alpha'));
  assert.ok(storage.includes('livenote_open_tabs:beta'));
});

test('Дерево запоминает раскрытие папок отдельно для каждого проекта', async (t) => {
  // Arrange: у двух проектов одинаковая структура, но разные имена.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const alpha = await openPage(context);
  const folder = (page, name) => page.getByRole('navigation', { name: 'Файлы хранилища' })
    .getByRole('button', { name, exact: true });
  await expect(alpha.getByRole('button', { name: 'Alpha', exact: true })).toBeVisible();
  await expect(folder(alpha, 'Раздел')).toHaveAttribute('aria-expanded', 'false');
  await expect(folder(alpha, 'Подраздел')).toBeHidden();

  // Act: раскрываем обе папки и открываем проект заново.
  await folder(alpha, 'Раздел').click();
  await folder(alpha, 'Подраздел').click();
  await alpha.reload();
  await expect(folder(alpha, 'Подраздел')).toHaveAttribute('aria-expanded', 'true');
  await alpha.close();
  const reopened = await openPage(context);

  // Assert: новый сеанс вкладки восстанавливает дерево, другой проект начинает со свёрнутого дерева.
  await expect(folder(reopened, 'Раздел')).toHaveAttribute('aria-expanded', 'true');
  await expect(folder(reopened, 'Подраздел')).toHaveAttribute('aria-expanded', 'true');
  const beta = await openPage(context, 'beta');
  await expect(beta.getByRole('button', { name: 'Beta', exact: true })).toBeVisible();
  await expect(folder(beta, 'Раздел')).toHaveAttribute('aria-expanded', 'false');
});

test('Successful picker routes the reserved popup and disowns its opener', { timeout: 90_000 }, async (t) => {
  // Arrange: системный picker возвращает второе хранилище.
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await openPage(context);
  await expect(page.locator('.cm-content')).toContainText('Заметка Alpha');
  const popupPromise = page.waitForEvent('popup');

  // Act: пользователь открывает папку через существующее меню LiveNote.
  await chooseOpenFolder(page);
  const popup = await popupPromise;
  await popup.waitForURL('**/?vault_id=beta');
  await expect(popup.locator('.cm-content')).toContainText('Заметка Beta');

  // Assert: исходная вкладка не изменилась, новая не имеет opener, endpoint остаётся глобальным.
  assert.equal(new URL(page.url()).searchParams.get('vault_id'), 'alpha');
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.equal(state.pickerCalls.at(-1).path, '/api/vaults/open');
  assert.equal(state.pickerCalls.at(-1).body, '{}');
});

test('Pending picker preserves the original tab and cancel closes only the popup', { timeout: 90_000 }, async (t) => {
  // Arrange: ответ picker удерживается до явного завершения теста.
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await openPage(context);
  await expect(page.locator('.cm-content')).toContainText('Заметка Alpha');
  let finishPicker;
  state.picker = () => new Promise((resolve) => { finishPicker = () => resolve({ vault: null }); });
  const popupPromise = page.waitForEvent('popup');

  // Act: ждём pending и отменяем системный выбор.
  await chooseOpenFolder(page);
  const popup = await popupPromise;
  await expect(page.locator('.vault-global-error[role="status"]')).toContainText('Системный диалог открыт');
  await expect(page.locator('.cm-content')).toContainText('Заметка Alpha');
  finishPicker();
  await expect(page.locator('.vault-global-error[role="status"]')).toContainText('Текущая вкладка осталась без изменений');

  // Assert: закрылась только зарезервированная вкладка.
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.locator('.cm-content')).toContainText('Заметка Alpha');
  state.picker = async () => ({ vault: { id: 'beta', name: 'Beta' } });
});

test('Picker failure closes the popup and shows the endpoint error', { timeout: 90_000 }, async (t) => {
  // Arrange: endpoint возвращает ошибку выбора папки.
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await openPage(context);
  state.picker = async () => { throw new Error('Системный диалог недоступен'); };
  const popupPromise = page.waitForEvent('popup');

  // Act: выполняем открытие папки.
  await chooseOpenFolder(page);
  const popup = await popupPromise;

  // Assert: исходная вкладка показывает ошибку endpoint.
  await expect(page.getByRole('alert')).toContainText('Системный диалог недоступен');
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.locator('.cm-content')).toContainText('Заметка Alpha');
  state.picker = async () => ({ vault: { id: 'beta', name: 'Beta' } });
});

test('Blocked popup does not call the picker or change the current vault', { timeout: 90_000 }, async (t) => {
  // Arrange: браузер запрещает window.open.
  const context = await browser.newContext();
  await context.addInitScript(() => { window.open = () => null; });
  t.after(() => context.close());
  const page = await openPage(context);
  const callsBefore = state.pickerCalls.length;

  // Act: пользователь пытается открыть папку.
  await chooseOpenFolder(page);

  // Assert: показывается локальная причина без обращения к endpoint.
  await expect(page.getByRole('alert')).toContainText('Браузер заблокировал новую вкладку');
  assert.equal(state.pickerCalls.length, callsBefore);
  assert.equal(new URL(page.url()).searchParams.get('vault_id'), 'alpha');
});

test('Keyboard menu action reserves a popup without blocking', { timeout: 90_000 }, async (t) => {
  // Arrange: фокус находится на trigger существующего меню LiveNote.
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await openPage(context);
  const popupPromise = page.waitForEvent('popup');

  // Act: открываем меню и выбираем папку только клавишей Enter.
  await page.getByRole('button', { name: 'Меню LiveNote' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Открыть папку', exact: true }).press('Enter');
  const popup = await popupPromise;

  // Assert: синхронная резервация в onAction пропускает popup и открывает Beta.
  await popup.waitForURL('**/?vault_id=beta');
  await expect(popup.locator('.cm-content')).toContainText('Заметка Beta');
  assert.equal(new URL(page.url()).searchParams.get('vault_id'), 'alpha');
});

test('Stale explicit vault shows unavailable and never falls back to default', { timeout: 90_000 }, async (t) => {
  // Arrange: сервер закрыл явно запрошенное хранилище.
  const context = await browser.newContext();
  t.after(() => context.close());
  const callsBefore = state.apiPaths.length;

  // Act: открываем закрытый ID напрямую.
  const page = await openPage(context, 'missing');

  // Assert: интерфейс не показывает Alpha и не делает запросов без vault.
  await expect(page.getByRole('heading', { name: 'Хранилище недоступно' })).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCount(0);
  const scopedCalls = state.apiPaths.slice(callsBefore);
  assert.ok(scopedCalls.some((item) => item.vaultId === 'missing'));
  assert.equal(scopedCalls.some((item) => item.vaultId === 'alpha' || item.vaultId === null), false);
});
