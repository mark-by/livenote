// allow: SIZE_OK — один сквозной сценарий с изолированным сервером, браузером и MCP.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDrawioLifecycleTrace } from './drawio-lifecycle-trace.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(project, 'package.json'));
const { chromium, expect } = require('playwright/test');
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);
const { createApp } = await import(pathToFileURL(join(project, 'dist/server/app.js')).href);
const log = [];
const label = 'Большая подпись схемы '.repeat(80);
const xml = revision => `<mxfile><diagram id="page" name="Схема"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" value="${label}${revision}" style="whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="50" y="50" width="400" height="160" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
const markdown = suffix => `# Тест\n\nВерсия ${suffix}\n\n![[diagram.drawio|Схема]]\n\nКонец.\n`;
const mermaid = suffix => `# Тест\n\nВерсия ${suffix}\n\n\`\`\`mermaid\nflowchart LR\n A["Начало ${suffix}"] --> B["Конец"]\n\`\`\`\n`;
const directory = await mkdtemp(join(tmpdir(), 'livenote-drawio-mcp-'));
const artifacts = process.env.DRAWIO_RELOAD_ARTIFACTS ?? directory;
let running;
let server;
let browser;
let context;
let page;
let client;
let releaseFrame = () => {};
let releaseSave = () => {};
try {
  await writeFile(join(directory, '00-main.md'), markdown('initial'));
  await writeFile(join(directory, '01-note.md'), '# Другая заметка\n');
  await writeFile(join(directory, 'diagram.drawio'), xml('initial'));
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  running = await createApp({ host: '127.0.0.1', port, vaultPath: directory, dbPath: '', token: null, openBrowser: false, mermaidTheme: 'default' });
  server = running.app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${port}`;
  client = new Client({ name: 'drawio-race-repro', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  async function mcp(name, args) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
    const value = JSON.parse(result.content[0].text);
    log.push({ event: 'mcp', name, args: { ...args, source: args.source?.slice(0, 100) }, result: value });
    return value;
  }
  async function document(path) { return mcp('get_document', { path }); }
  async function writeNote(source) {
    const current = await document('00-main.md');
    return mcp('write_document', { path: current.path, expected_revision: current.page.revision, expected_version: current.version, source });
  }
  async function writeDiagram(revision) {
    const current = await document('diagram.drawio');
    return mcp('write_diagram', { page_id: current.path, block_id: current.page.blocks[0].id,
      expected_revision: current.page.revision, expected_version: current.version, format: 'drawio', source: xml(revision) });
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  await page.addInitScript(installDrawioLifecycleTrace);
  page.on('request', request => {
    if (request.url().includes('/rendered')) log.push({ event: 'render-request', body: request.postDataJSON() });
  });
  page.on('response', response => {
    if (response.url().includes('/rendered')) log.push({ event: 'render-response', status: response.status() });
  });
  let frameStarted;
  const frameSeen = new Promise(resolve => { frameStarted = resolve; });
  const frameGate = new Promise(resolve => { releaseFrame = resolve; });
  let gated = false;
  await page.route('**/drawio/index.html?*', async route => {
    if (!gated) {
      gated = true;
      log.push({ event: 'frame-blocked', url: route.request().url() });
      frameStarted();
      await frameGate;
    }
    await route.continue();
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vault-tree__page').filter({ hasText: '00-main' })).toBeVisible();
  await page.locator('.vault-tree__page').filter({ hasText: '00-main' }).click();
  await frameSeen;
  log.push({ event: 'experiment-init-write-start' });
  await writeDiagram('init-1');
  await writeNote(markdown('init-1'));
  await writeDiagram('init-2');
  await writeNote(markdown('init-2'));
  releaseFrame();
  await expect(page.locator('.drawio-preview__image').first()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.vault-document:not([hidden]) .cm-content')).toContainText('Версия init-2');
  log.push({ event: 'experiment-init-write-complete' });
  const initiallyRendered = await mcp('get_page', { page_id: '00-main.md' });
  const savedBlock = initiallyRendered.blocks.find(block => block.type === 'drawio');
  const seeded = await fetch(`${base}/api/pages/${encodeURIComponent('00-main.md')}/blocks/${encodeURIComponent(savedBlock.id)}/rendered`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: initiallyRendered.revision, ok: false, error: 'Искусственная прежняя ошибка' })
  });
  assert.equal(seeded.status, 204);
  const seededPage = await client.callTool({ name: 'get_page', arguments: { page_id: '00-main.md' } });
  assert.equal(JSON.parse(seededPage.content[0].text).blocks.find(block => block.type === 'drawio').renderOk, false);
  log.push({ event: 'seeded-existing-render-error' });
  const cleared = page.waitForResponse(response => response.url().includes('/rendered') &&
    response.request().postDataJSON().ok === true && response.status() === 204, { timeout: 45_000 });
  await page.reload();
  await cleared;
  const clearedPage = await mcp('get_page', { page_id: '00-main.md' });
  assert.equal(clearedPage.blocks.find(block => block.type === 'drawio').renderError, null);
  assert.equal(clearedPage.blocks.find(block => block.type === 'drawio').renderOk, true);
  log.push({ event: 'cleared-existing-render-error' });

  await page.evaluate(() => { window.__holdExports = true; });
  await writeDiagram('export-pending');
  await page.waitForFunction(() => window.__drawioTrace.some(event => event.event === 'export-request' && event.held), null, { timeout: 30_000 });
  log.push({ event: 'experiment-export-held' });
  const previewHeight = await page.locator('.drawio-preview').first().evaluate(element => element.getBoundingClientRect().height);
  await page.evaluate(() => {
    const frame = document.querySelector('iframe.drawio-frame-host');
    window.__dirtyFrame = frame;
    window.__dirtyDocument = frame.contentDocument;
    window.__dirtyXml = window.__frameBlock(frame).xml;
    window.__dirtyBlockId = window.__frameBlock(frame).blockId;
  });
  await mcp('get_page', { page_id: '00-main.md' });
  log.push({ event: 'held-visible-errors', errors: await page.locator('.drawio-error').allTextContents() });
  await page.screenshot({ path: join(artifacts, 'fullapp-export-held.png') });
  const editor = page.locator('.vault-document:not([hidden]) .cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  let saveStarted;
  const saveSeen = new Promise(resolve => { saveStarted = resolve; });
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  await page.route(/\/api\/(?:vaults\/[^/]+\/)?pages\/[^/]+\/document$/, async route => {
    if (route.request().method() === 'PUT') {
      saveStarted();
      await saveGate;
    }
    await route.continue();
  });
  const saved = page.waitForResponse(response => response.url().includes('/document') &&
    response.request().method() === 'PUT' && response.status() === 200, { timeout: 30_000 });
  await page.keyboard.type(' Dirty transition');
  await saveSeen;
  const dirtyBlock = await page.evaluate(() => {
    const frame = document.querySelector('iframe.drawio-frame-host');
    const block = window.__frameBlock(frame);
    return { blockId: block.blockId, sameXml: block.xml === window.__dirtyXml,
      sameDocument: frame.contentDocument === window.__dirtyDocument };
  });
  log.push({ event: 'dirty-before-save', ...dirtyBlock });
  assert.notEqual(dirtyBlock.blockId, await page.evaluate(() => window.__dirtyBlockId));
  assert.equal(dirtyBlock.sameXml, true);
  assert.equal(dirtyBlock.sameDocument, true);
  releaseSave();
  await saved;
  await expect.poll(async () => (await document('00-main.md')).source).toContain('Dirty transition');
  log.push({ event: 'experiment-dirty-saved' });
  const dirtyState = await page.evaluate(() => {
    const frame = document.querySelector('iframe.drawio-frame-host');
    return {
      sameFrame: frame === window.__dirtyFrame,
      sameDocument: frame.contentDocument === window.__dirtyDocument,
      sameXml: window.__frameBlock(frame).xml === window.__dirtyXml,
      previousBlockId: window.__dirtyBlockId,
      currentBlockId: window.__frameBlock(frame).blockId
    };
  });
  log.push({ event: 'dirty-identity', ...dirtyState });
  assert.equal(dirtyState.sameXml, true);
  assert.equal(dirtyState.sameFrame, true);
  assert.equal(dirtyState.sameDocument, true, 'Изменение block.id не должно перезагружать ту же схему.');
  assert.equal(await page.locator('.drawio-preview').first().evaluate(element => element.getBoundingClientRect().height), previewHeight);
  await mcp('get_page', { page_id: '00-main.md' });
  await writeDiagram('export-pending-next');
  await page.evaluate(() => window.__releaseExports());
  await expect(page.locator('.vault-document:not([hidden]) .drawio-preview__image')).toBeVisible({ timeout: 45_000 });
  await mcp('get_page', { page_id: '00-main.md' });
  log.push({ event: 'experiment-export-complete' });

  await page.locator('.vault-tree__page').filter({ hasText: '01-note' }).click();
  await expect(page.locator('.vault-document:not([hidden]) .cm-content')).toContainText('Другая заметка');
  await writeDiagram('hidden');
  await writeNote(markdown('hidden'));
  await page.locator('.vault-document-tabs [role="tab"]').filter({ hasText: '00-main' }).click();
  await expect(page.locator('.vault-document:not([hidden]) .cm-content')).toContainText('Версия hidden');
  await expect(page.locator('.drawio-preview__image').first()).toBeVisible({ timeout: 45_000 });
  log.push({ event: 'experiment-hidden-complete' });

  const diagramBeforeSwitch = await document('diagram.drawio');
  await writeNote(mermaid('first'));
  await expect(page.locator('.vault-document:not([hidden]) .mermaid-block svg.flowchart')).toBeVisible({ timeout: 45_000 });
  // Последняя вставка удаляет файл, поэтому для нового формата создаём его заново.
  await writeFile(join(directory, 'diagram.drawio'), diagramBeforeSwitch.source);
  await writeNote(markdown('format-drawio'));
  await expect(page.locator('.vault-document:not([hidden]) .drawio-preview__image')).toBeVisible({ timeout: 45_000 });
  await writeNote(mermaid('last'));
  await expect(page.locator('.vault-document:not([hidden]) .mermaid-block svg.flowchart')).toBeVisible({ timeout: 45_000 });
  await writeFile(join(directory, 'diagram.drawio'), diagramBeforeSwitch.source);
  await writeNote(markdown('final'));
  await expect(page.locator('.vault-document:not([hidden]) .drawio-preview__image')).toBeVisible({ timeout: 45_000 });
  log.push({ event: 'experiment-format-complete' });
  const beforeManual = await mcp('get_page', { page_id: '00-main.md' });
  const oldImage = await page.locator('.vault-document:not([hidden]) .drawio-preview__image').getAttribute('src');
  await page.evaluate(() => window.__drawioTrace.push({ event: 'manual-open', time: performance.now() }));
  await page.locator('.vault-document:not([hidden]) .diagram-adapter').getByRole('button', { name: 'Редактировать диаграмму' }).click();
  const dialog = page.locator('.drawio-fullscreen');
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled({ timeout: 45_000 });
  const canvas = dialog.locator('iframe').contentFrame().locator('.geDiagramContainer');
  await canvas.getByText(/Большая подпись схемы/).first().dblclick();
  const cell = dialog.locator('iframe').contentFrame().locator('.mxCellEditor[contenteditable="true"]:visible');
  await expect(cell).toBeFocused();
  await page.keyboard.type('Ручное сохранение');
  await page.keyboard.press('Escape');
  await expect(dialog.locator('.drawio-fullscreen__dirty')).toBeVisible();
  log.push({ event: 'experiment-manual-save-start' });
  await page.evaluate(() => window.__drawioTrace.push({ event: 'manual-save', time: performance.now() }));
  const manualRendered = page.waitForResponse(response => response.url().includes('/rendered') &&
    response.request().postDataJSON().ok === true &&
    response.request().postDataJSON().revision !== beforeManual.revision && response.status() === 204, { timeout: 45_000 });
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.vault-document:not([hidden]) .drawio-preview__image')).not.toHaveAttribute('src', oldImage, { timeout: 45_000 });
  await manualRendered;
  const afterManual = await mcp('get_page', { page_id: '00-main.md' });
  assert.match(afterManual.blocks.find(block => block.type === 'drawio').source, /Ручное сохранение/);
  log.push({ event: 'experiment-manual-save-complete' });
  await page.evaluate(() => window.__drawioTrace.push({ event: 'manual-complete', time: performance.now() }));
  const errors = await page.locator('.drawio-error, .drawio-fullscreen__error').allTextContents();
  log.push({ event: 'visible-errors', errors });
  assert.deepEqual(errors, []);
  const failedRenders = log.filter(entry => entry.event === 'render-request' && entry.body.ok === false);
  const failedPages = log.filter(entry => entry.event === 'mcp' && entry.name === 'get_page' &&
    entry.result.blocks.some(block => block.type === 'drawio' && (block.renderOk === false || block.renderError)));
  assert.deepEqual({ failedRenders, failedPages }, { failedRenders: [], failedPages: [] },
    'Корректная схема не должна получать ошибку рендера на любой ревизии.');
  console.log('PASS: init updates, hidden updates, format transitions');
} catch (error) {
  log.push({ event: 'failure', message: error instanceof Error ? error.stack : String(error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  releaseFrame();
  releaseSave();
  if (page) {
    try {
      log.push({ event: 'browser-trace', entries: await page.evaluate(() => window.__drawioTrace) });
      await page.screenshot({ path: join(artifacts, 'fullapp-screen.png') });
    } catch (error) { log.push({ event: 'capture-error', message: String(error) }); }
  }
  await writeFile(join(artifacts, 'fullapp-trace.json'), JSON.stringify(log, null, 2));
  await context?.close();
  await browser?.close();
  await client?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await running?.close();
  await rm(directory, { recursive: true, force: true });
}
