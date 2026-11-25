import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, expect } from 'playwright/test';
import { createServer as createVite } from 'vite';
import { createApp } from '../src/server/app.ts';

const timeout = 60_000;
const inlineSource = '# 📘 Заметка\n\n```mermaid\nflowchart LR\n  Start["Начало"] --> End["Конец"]\n```\n';
const bpmn = `<b:definitions xmlns:b="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:d="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:c="http://www.omg.org/spec/DD/20100524/DC" targetNamespace="urn:fixture">
  <b:process id="Process_1"><b:task id="Task_1" name="Задача"/></b:process>
  <d:BPMNDiagram id="Diagram_1"><d:BPMNPlane id="Plane_1" bpmnElement="Process_1">
    <d:BPMNShape id="Shape_1" bpmnElement="Task_1"><c:Bounds x="200" y="120" width="100" height="80"/></d:BPMNShape>
  </d:BPMNPlane></d:BPMNDiagram>
</b:definitions>`;
const drawioPage = (id, name, label) => `<diagram id="${id}" name="${name}"><mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" value="${label}" vertex="1" parent="1">
  <mxGeometry x="80" y="80" width="160" height="64" as="geometry"/></mxCell>
</root></mxGraphModel></diagram>`;
const drawio = `<mxfile>${drawioPage('first', 'Первая', 'Начало')}${drawioPage('second', 'Вторая', 'Другой узел')}</mxfile>`;
const assetNote = '# Процесс\n\n![[process.bpmn|Схема процесса]]\n';
const fixtureModule = `
  import React, { StrictMode, useLayoutEffect } from 'react';
  import { createRoot } from 'react-dom/client';
  import { useVaultWorkspace } from '/vault/useVaultWorkspace.ts';
  import { VaultEditors } from '/vault/VaultEditors.tsx';
  import '/heroui.css';
  import '/styles.css';
  import '/vault.css';
  function Fixture() {
    const workspace = useVaultWorkspace(false, false, null, false);
    useLayoutEffect(() => { window.workspace = workspace; });
    return React.createElement(VaultEditors, {
      workspace, theme: 'light', vimEnabled: false, onRevealFolder() {},
      agentPanel: React.createElement('input', { 'aria-label': 'Запрос агенту' })
    });
  }
  createRoot(document.querySelector('#root')).render(React.createElement(StrictMode, null, React.createElement(Fixture)));
`;

let browser, server, app, vite, base, vault, temp;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'livenote-agent-editor-'));
  vault = join(temp, 'vault');
  await mkdir(vault);
  await writeFile(join(vault, 'Схема.md'), inlineSource);
  await writeFile(join(vault, 'Процесс.md'), assetNote);
  await writeFile(join(vault, 'process.bpmn'), bpmn);
  await writeFile(join(vault, 'flow.drawio'), drawio);
  await writeFile(join(vault, 'Текст.md'), '# Текст\n');
  server = createServer((req, res) => {
    if (req.url === '/') {
      const html = '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/@id/agent-editor-fixture"></script>';
      void vite.transformIndexHtml('/', html).then(body => res.setHeader('Content-Type', 'text/html').end(body));
    } else if (/^\/(?:api|events|drawio)(?:\/|$)/.test(req.url ?? '')) app.app(req, res);
    else vite.middlewares(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
  app = await createApp({ port, host: '127.0.0.1', vaultPath: vault,
    dbPath: join(temp, 'unused.sqlite'), openBrowser: false, token: null, mermaidTheme: 'default' }, { cacheHome: join(temp, 'cache') });
  vite = await createVite({
    configFile: false, root: join(process.cwd(), 'src/web'), cacheDir: join(temp, 'vite'), appType: 'custom',
    server: { middlewareMode: true, hmr: false, fs: { allow: [process.cwd()] } },
    plugins: [react(), tailwindcss(), {
      name: 'agent-editor-fixture',
      resolveId(id) { if (id === 'agent-editor-fixture') return '\0agent-editor-fixture'; },
      load(id) { if (id === '\0agent-editor-fixture') return fixtureModule; }
    }]
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  if (server?.listening) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
  await vite?.close();
  await app?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

async function openDocument(t, path) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  t.after(() => page.close());
  await page.goto(base);
  await page.waitForFunction(() => window.workspace?.ready);
  await page.evaluate(path => window.workspace.openPage(path), path);
  await page.locator('.vault-document').filter({ visible: true }).waitFor();
  return page;
}

async function open(t, path) {
  const page = await openDocument(t, path);
  await page.locator('.diagram-adapter').first().hover();
  await page.getByRole('button', { name: 'Редактировать диаграмму' }).click();
  return { page, dialog: page.getByRole('dialog').first() };
}

test('Mermaid передаёт выбранный узел и черновик с диапазоном UTF-16 без записи', { timeout }, async t => {
  // Arrange: открываем настоящую диаграмму внутри заметки.
  const { page, dialog } = await open(t, 'Схема.md');
  await dialog.locator('.node').filter({ hasText: 'Начало' }).click();
  await dialog.getByLabel('Подпись узла', { exact: true }).fill('Черновик');
  // Act: фиксируем фокус и сразу меняем выделение.
  const focus = await page.evaluate(async () => {
    const result = window.workspace.captureAgentFocus();
    document.querySelector('.diagram-fullscreen__svg [data-id="End"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return result;
  });
  // Assert: фокус содержит исходный выбор, а диапазон указывает на новое содержимое.
  assert.deepEqual(focus.selected, [{ id: 'Start', kind: 'node' }]);
  const expected = inlineSource.replace('Начало', 'Черновик');
  assert.deepEqual(focus.target, { kind: 'inline', from: 14, to: expected.length - 1 });
  assert.equal(focus.overlay.source, expected);
  assert.equal(focus.overlay.expectedVersion, focus.base.version);
  assert.equal(focus.overlay.expectedRevision, focus.base.revision);
  assert.equal('requestId' in focus.overlay, false);
  assert.equal(await readFile(join(vault, 'Схема.md'), 'utf8'), inlineSource);
  const panel = dialog.getByLabel('Запрос агенту');
  await panel.fill('Сравнить ветки');
  await expect(panel).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
  await page.evaluate(() => window.workspace.finishAgentTurn([]));
  await expect(dialog.locator('.node').filter({ hasText: 'Черновик' })).toBeVisible();
});

test('BPMN передаёт ID задачи и незавершённую подпись во вложении', { timeout }, async t => {
  // Arrange: открываем вложение и начинаем править его подпись.
  const { page, dialog } = await open(t, 'Процесс.md');
  const task = dialog.locator('[data-element-id="Task_1"].djs-element');
  await task.dblclick();
  const label = dialog.locator('.djs-direct-editing-content');
  await label.fill('Новая задача');
  // Act: захватываем контекст, не закрывая ввод вручную.
  const focus = await page.evaluate(() => window.workspace.captureAgentFocus());
  // Assert: заметка не меняется, а черновик лежит в записи вложения.
  assert.deepEqual(focus.target, { kind: 'asset', path: 'process.bpmn' });
  assert.deepEqual(focus.selected, [{ id: 'Task_1', kind: 'node' }]);
  assert.equal(focus.overlay.source, assetNote);
  assert.equal(focus.overlay.assets.length, 1);
  assert.equal(focus.overlay.assets[0].path, 'process.bpmn');
  assert.match(focus.overlay.assets[0].source, /name="Новая задача"/);
  assert.equal(await readFile(join(vault, 'process.bpmn'), 'utf8'), bpmn);
  await task.click();
  await page.keyboard.press('Backspace');
  await expect(task).toBeVisible();
});

test('draw.io берёт выбор со второй страницы и завершает текущий ввод без записи', { timeout }, async t => {
  // Arrange: обе страницы содержат ячейку с одним ID.
  const { page, dialog } = await open(t, 'flow.drawio');
  const frame = dialog.locator('iframe').contentFrame();
  await frame.getByText('Вторая', { exact: true }).first().click();
  const cell = frame.locator('.geDiagramContainer').getByText('Другой узел', { exact: true });
  await cell.dblclick();
  const label = frame.locator('.mxCellEditor[contenteditable="true"]:visible');
  await expect(label).toBeFocused();
  await page.keyboard.type('Свежий XML');
  // Act: считываем выбор до resetEditor, который очищает выделение.
  const focus = await page.evaluate(() => window.workspace.captureAgentFocus());
  // Assert: ответ различает страницы и содержит свежий XML.
  assert.deepEqual(focus.target, { kind: 'file' });
  assert.deepEqual(focus.selected, [{ id: 'node', kind: 'element', pageId: 'second' }]);
  assert.match(focus.overlay.source, /Свежий XML/);
  assert.equal(await readFile(join(vault, 'flow.drawio'), 'utf8'), drawio);
  const edited = frame.locator('.geDiagramContainer').getByText('Свежий XML', { exact: true });
  await edited.dblclick();
  await expect(label).toHaveCount(0);
  await page.keyboard.press('Backspace');
  await expect(edited).toBeVisible();
  await page.evaluate(() => window.workspace.finishAgentTurn([]));
  await edited.dblclick();
  await expect(label).toBeFocused();
});

test('Завершение обновляет захваченную схему, а отмена защищает открытые черновики', { timeout }, async t => {
  // Arrange: открываем Mermaid и готовим отдельный черновик в другой вкладке.
  const { page, dialog } = await open(t, 'Схема.md');
  await page.evaluate(() => window.workspace.openPage('Текст.md'));
  await page.waitForFunction(() => window.workspace.drafts['Текст.md']);
  // Act: имитируем публикацию агента записью в тестовый vault до finishAgentTurn.
  const result = await page.evaluate(async () => {
    await window.workspace.captureAgentFocus();
    window.workspace.changeDraft('Текст.md', '# Черновик');
    try { await window.workspace.guardUndo(['Текст.md']); }
    catch (error) { return error.message; }
  });
  assert.match(result, /Текст\.md/);
  const path = join(vault, 'Схема.md');
  try {
    await writeFile(path, inlineSource.replace('Конец', 'Результат'));
    await page.evaluate(() => window.workspace.finishAgentTurn(['Схема.md']));
    // Assert: редактор схемы остаётся открыт и видит новый исходник.
    await expect(dialog.locator('.node').filter({ hasText: 'Результат' })).toBeVisible();
    assert.equal(await page.evaluate(() => window.workspace.drafts['Текст.md'].source), '# Черновик');
    assert.equal(await page.evaluate(() => window.workspace.agentDiagramPath), 'Схема.md');
  } finally { await writeFile(path, inlineSource); }
});

test('Захват Markdown дожидается автосохранения и возвращает новую версию', { timeout }, async t => {
  // Arrange: ручной ввод ещё не дошёл до таймера автосохранения.
  const page = await openDocument(t, 'Текст.md');
  const result = await page.evaluate(async () => {
    const workspace = window.workspace;
    const previousVersion = workspace.documents['Текст.md'].version;
    workspace.changeDraft('Текст.md', '# Сохранённый текст\n');
    // Act: отправка должна дождаться настоящего PUT.
    const focus = await workspace.captureAgentFocus();
    return { focus, previousVersion };
  });
  // Assert: захват не несёт черновик и ссылается на записанную версию.
  assert.equal(await readFile(join(vault, 'Текст.md'), 'utf8'), '# Сохранённый текст\n');
  assert.notEqual(result.focus.base.version, result.previousVersion);
  const response = await page.request.get(`${base}/api/pages/${encodeURIComponent('Текст.md')}/document`);
  assert.equal(response.ok(), true);
  const { document } = await response.json();
  assert.deepEqual(result.focus, { kind: 'document', path: 'Текст.md',
    base: { version: document.version, revision: document.page.revision } });
});

test('Отмена не начинает запись поверх открытого черновика', { timeout }, async t => {
  // Arrange: создаём локальный черновик в затронутой заметке.
  const page = await openDocument(t, 'Текст.md');
  await page.evaluate(() => window.workspace.changeDraft('Текст.md', '# Локальный черновик\n'));
  // Act: проверяем отмену до истечения таймера автосохранения.
  const result = await page.evaluate(async () => {
    try { await window.workspace.guardUndo(['Текст.md']); }
    catch (error) { return error.message; }
  });
  // Assert: защита сообщает путь и оставляет черновик.
  assert.match(result, /Нельзя отменить правки:.*Текст\.md/);
  assert.equal(await page.evaluate(() => window.workspace.drafts['Текст.md'].source), '# Локальный черновик\n');
});

test('Сохранение Mermaid после снятия блокировки пишет черновик и возвращает фокус', { timeout }, async t => {
  // Arrange: захватили схему и получили ошибку операции без записанных путей.
  const { page, dialog } = await open(t, 'Схема.md');
  await dialog.locator('.node').filter({ hasText: 'Начало' }).click();
  await dialog.getByLabel('Подпись узла', { exact: true }).fill('Ручная правка');
  await page.evaluate(async () => {
    await window.workspace.captureAgentFocus();
    await window.workspace.finishAgentTurn([]);
  });
  // Act: сохраняем тем же действием, что и без чата.
  const path = join(vault, 'Схема.md');
  try {
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    // Assert: результат записан, диалог закрыт, фокус вернулся к заметке.
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.cm-content')).toBeFocused();
    assert.equal(await readFile(path, 'utf8'), inlineSource.replace('Начало', 'Ручная правка'));
  } finally { await writeFile(path, inlineSource); }
});
