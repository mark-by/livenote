import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createServer as createVite } from 'vite';
import { createApp } from '../src/server/app.ts';

const timeout = 30_000;
const documentPath = (id) => `/pages/${encodeURIComponent(id)}/document`;
const tokens = ({ page, version }) => ({ expectedRevision: page.revision, expectedVersion: version });

const fixtureHtml = `<meta charset="utf-8"><div id="root"></div>
  <script type="module" src="/@id/workspace-fixture"></script>`;
const fixtureModule = `
  import { createElement, useLayoutEffect } from 'react';
  import { createRoot } from 'react-dom/client';
  import { useVaultWorkspace } from '/src/web/vault/useVaultWorkspace.ts';
  import { vaultPanes } from '/src/web/vault/vaultPaneState.ts';
  function Fixture() {
    const workspace = useVaultWorkspace(false, false, null, false);
    useLayoutEffect(() => {
      window.workspace = workspace;
      window.panes = workspace.paneLayout ? vaultPanes(workspace.paneLayout.root) : [];
    });
    return null;
  }
  createRoot(document.querySelector('#root')).render(createElement(Fixture));
`;

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'livenote-workspace-'));
  const vault = join(root, 'vault');
  let app, vite, browser;
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixtureHtml);
    } else if (req.url?.startsWith('/api/') || req.url === '/events') {
      app.app(req, res);
    } else {
      vite.middlewares(req, res);
    }
  });
  t.after(async () => {
    try {
      await browser?.close();
      await vite?.close();
      if (server.listening) {
        const closed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await closed;
      }
      await app?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  for (const [name, source] of Object.entries(files)) {
    const path = join(vault, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  app = await createApp({
    port, host: '127.0.0.1', vaultPath: vault, dbPath: join(root, 'unused.sqlite'),
    openBrowser: false, token: null, mermaidTheme: 'default'
  }, { cacheHome: join(root, 'cache') });
  vite = await createVite({
    configFile: false, cacheDir: join(root, 'vite'), server: { middlewareMode: true, ws: false }, appType: 'custom',
    optimizeDeps: { include: ['react', 'react-dom/client'], noDiscovery: true },
    plugins: [{
      name: 'workspace-fixture',
      resolveId(id) { return id === 'workspace-fixture' ? '\0workspace-fixture' : undefined; },
      load(id) { return id === '\0workspace-fixture' ? fixtureModule : undefined; }
    }]
  });
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  page.setDefaultTimeout(timeout / 3);
  await page.addInitScript(() => {
    window.workspaceEvents = [];
    window.SharedWorker = class extends window.SharedWorker {
      constructor(...args) {
        super(...args);
        this.port.addEventListener('message', ({ data }) => {
          window.workspaceEvents.push(data.name === 'open' ? { event: 'open' } : JSON.parse(data.data));
        });
      }
    };
    window.vaultGets = 0;
    const fetch = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (url === '/api/vault') window.vaultGets++;
      return fetch(url, options);
    };
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto(base);
  await page.waitForFunction(() => window.workspace?.ready && window.workspaceEvents.some(({ event }) => event === 'open'));
  await page.evaluate(() => window.workspace.refresh());
  assert.deepEqual(errors, []);
  async function api(path, method = 'GET', body, status = 200) {
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  }
  return { page, vault, api, async document(id) { return (await api(documentPath(id))).document; } };
}

async function holdResponse(page, path, method) {
  const arrived = Promise.withResolvers();
  const gate = Promise.withResolvers();
  await page.route(path, async (route) => {
    if (route.request().method() !== method) return route.continue();
    try {
      const response = await route.fetch();
      arrived.resolve({ status: response.status(), body: await response.text(), requestBody: route.request().postData() });
      await gate.promise;
      await route.fulfill({ response });
    } catch (error) {
      arrived.reject(error);
      throw error;
    }
  }, { times: 1 });
  return { arrived: arrived.promise, release: gate.resolve };
}

test('workspace A1: перенос папки сохраняет панели, историю и черновик, созданный во время запроса', { timeout }, async (t) => {
  // Arrange: в двух панелях открыты файлы из переносимой папки.
  const left = 'Docs/Left.md';
  const right = 'Docs/Right.md';
  const { page, vault, api } = await fixture(t, { [left]: '# Слева\n', [right]: '# Справа\n', 'ZArchive/Readme.md': '# Архив\n' });
  await page.evaluate(({ left, right }) => {
    window.workspace.openPage(left);
    window.workspace.keepTab(left);
    window.workspace.splitTab(left, 'right');
    window.workspace.openLinkedPage(right, 'intro');
  }, { left, right });
  await page.waitForFunction((right) => window.workspace.documents[right], right);

  // Act: сервер переносит папку, а редактор получает правку до ответа.
  const movedFolder = 'ZArchive/Docs';
  const localSource = '# Локальный черновик\n';
  const response = await holdResponse(page, '**/api/vault/folders/move', 'POST');
  try {
    const treeBefore = await api('/vault');
    await page.evaluate((path) => { window.moveDone = window.workspace.moveFolder('Docs', path); }, movedFolder);
    const received = await response.arrived;
    assert.equal(received.status, 200, `${received.body}; запрос ${received.requestBody}; версия сервера ${treeBefore.treeVersion}`);
    await page.evaluate(({ right, localSource }) => window.workspace.changeDraft(right, localSource), { right, localSource });
  } finally {
    response.release();
  }
  assert.equal(await page.evaluate(() => window.moveDone), null);

  // Assert: пути согласованы, а черновик не попал на диск и оставлен для разрешения конфликта.
  const movedLeft = `${movedFolder}/Left.md`;
  const movedRight = `${movedFolder}/Right.md`;
  const state = await page.evaluate(({ left, right, movedRight }) => {
    const { activeId, documents, drafts, fragmentTarget, history, openTabs } = window.workspace;
    return {
      activeId, openTabs, fragmentTarget, history, panes: window.panes.map(({ path }) => path),
      stalePaths: [documents[left], documents[right], drafts[left], drafts[right]].some(Boolean),
      documentPath: documents[movedRight]?.path, documentId: documents[movedRight]?.page.id,
      source: drafts[movedRight]?.source, conflict: Boolean(drafts[movedRight]?.conflict)
    };
  }, { left, right, movedRight });
  assert.deepEqual(state, {
    activeId: movedRight, openTabs: [movedLeft, movedRight], panes: [movedLeft, movedRight],
    fragmentTarget: { pageId: movedRight, fragment: 'intro' }, history: { entries: [movedLeft, movedRight], index: 1 },
    stalePaths: false, documentPath: movedRight, documentId: movedRight, source: localSource, conflict: true
  });
  assert.equal(await readFile(join(vault, movedRight), 'utf8'), '# Справа\n');
  t.diagnostic('Обе панели, история и цель ссылки получили новые пути. Правка осталась в черновике.');
});

test('workspace F3: события трёх файлов при задержке снимка дают один повтор и сохраняют черновики', { timeout }, async (t) => {
  // Arrange: два открытых черновика. Диалоги удерживают их от автосохранения.
  const removed = 'First.md';
  const edited = 'Second.md';
  const renamed = 'Third.md';
  const destination = 'Renamed.md';
  const { page, api, document } = await fixture(t, {
    [removed]: '# Первая\n', [edited]: '# Вторая\n', [renamed]: '# Третья\n'
  });
  await page.evaluate(({ removed, edited }) => {
    window.workspace.keepTab(removed);
    window.workspace.openPage(edited);
  }, { removed, edited });
  await page.waitForFunction((edited) => window.workspace.documents[edited], edited);
  const local = { [removed]: 'Черновик удалённого файла', [edited]: 'Черновик изменённого файла' };
  await page.evaluate((local) => {
    for (const [path, source] of Object.entries(local)) {
      window.workspace.setModalOpen(path, true);
      window.workspace.changeDraft(path, source);
    }
    window.vaultGets = 0;
  }, local);
  const [removedDoc, editedDoc, renamedDoc] = await Promise.all([removed, edited, renamed].map(document));

  // Act: первый снимок уже прочитан на сервере, но браузер ещё не получил ответ.
  const response = await holdResponse(page, '**/api/vault', 'GET');
  try {
    await api(`/pages/${removed}`, 'DELETE', tokens(removedDoc), 204);
    const received = await response.arrived;
    assert.equal(received.status, 200, received.body);
    await api(documentPath(edited), 'PUT', { ...tokens(editedDoc), source: '# Внешняя правка\n' });
    await api(`/pages/${renamed}/move`, 'POST', { ...tokens(renamedDoc), path: destination });
    await page.waitForFunction(({ removed, edited, destination }) => {
      const events = window.workspaceEvents;
      return events.some(({ event, pageId }) => event === 'page.deleted' && pageId === removed)
        && events.some(({ event, pageId }) => event === 'page.updated' && pageId === edited)
        && events.some(({ event, pageId }) => event === 'page.moved' && pageId === destination)
        && events.some(({ event }) => event === 'vault.updated');
    }, { removed, edited, destination });
    const pending = await page.evaluate(({ removed, edited }) => ({
      requests: window.vaultGets,
      deletedConflict: Boolean(window.workspace.drafts[removed]?.conflict),
      updatedFlag: window.workspace.drafts[edited]?.externalChange
    }), { removed, edited });
    t.diagnostic(`До ответа /api/vault: ${JSON.stringify(pending)}`);
    assert.deepEqual(pending, { requests: 1, deletedConflict: true, updatedFlag: true });
  } finally {
    response.release();
  }

  // Assert: повтор получает новое дерево, не заменяя ни один из черновиков.
  await page.waitForFunction((destination) => window.workspace.snapshot.files.some(({ path }) => path === destination), destination);
  const final = await page.evaluate(({ removed, edited }) => ({
    requests: window.vaultGets,
    files: window.workspace.snapshot.files.map(({ path }) => path).sort(),
    drafts: [window.workspace.drafts[removed]?.source, window.workspace.drafts[edited]?.source]
  }), { removed, edited });
  t.diagnostic(`После ответа /api/vault: ${JSON.stringify(final)}`);
  assert.deepEqual(final, { requests: 2, files: [destination, edited].sort(), drafts: [local[removed], local[edited]] });
});
