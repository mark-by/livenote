import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium, expect } from 'playwright/test';
import { createApp } from '../dist/server/app.js';

test('Скрытая диаграмма не прерывает ввод и сохранение другой заметки', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'livenote-drawio-vault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const xml = '<mxfile><diagram name="Схема"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
  await writeFile(join(directory, '00-diagram.md'), '# Диаграмма\n\n![[diagram.drawio]]\n');
  await writeFile(join(directory, '01-note.md'), '# Заметка\n');
  await writeFile(join(directory, 'diagram.drawio'), xml);
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = { host: '127.0.0.1', port, vaultPath: directory, dbPath: '', token: null, openBrowser: false, mermaidTheme: 'default' };
  const running = await createApp(config);
  const server = running.app.listen(port, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await running.close();
  });
  const base = `http://127.0.0.1:${config.port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  let releaseFrame;
  const frameGate = new Promise(resolve => { releaseFrame = resolve; });
  let notifyFrame;
  const frameStarted = new Promise(resolve => { notifyFrame = resolve; });
  let releaseSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  let notifySave;
  const saveStarted = new Promise(resolve => { notifySave = resolve; });
  let firstSave = true;
  t.after(() => { releaseFrame(); releaseSave(); });
  await page.route('**/drawio/index.html?*', async route => {
    notifyFrame();
    await frameGate;
    await route.continue();
  });
  await page.route(/\/api\/(?:vaults\/[^/]+\/)?pages\/[^/]+\/document$/, async route => {
    if (route.request().method() === 'PUT' && firstSave) {
      firstSave = false;
      notifySave();
      await saveGate;
    }
    await route.continue();
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vault-tree__page').filter({ hasText: '00-diagram' })).toBeVisible();
  await frameStarted;
  // Закрепляем вкладку, чтобы открытие другой заметки не заменило её.
  await page.getByRole('tab').filter({ hasText: '00-diagram' }).click();
  await page.locator('.vault-tree__page').filter({ hasText: '01-note' }).click();
  const editor = page.locator('.vault-document:not([hidden]) .cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.type(' ALPHA');
  await saveStarted;
  releaseFrame();
  await expect(page.locator('.vault-document[hidden] .drawio-preview__image')).toHaveCount(1, { timeout: 30_000 });
  await expect(editor).toBeFocused();
  await page.keyboard.type(' BETA');
  await expect(editor).toContainText('ALPHA BETA');
  const screenshots = process.env.LIVENOTE_DIAGRAM_SCREENSHOTS;
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, 'hidden-diagram-editor.png') });
  }
  releaseSave();
  await expect.poll(async () => {
    const response = await fetch(`${base}/api/pages/${encodeURIComponent('01-note.md')}/document`);
    return (await response.json()).document.source;
  }).toContain('ALPHA BETA');
  assert.equal(await page.locator('.vault-document[hidden] .drawio-preview__image').count(), 1);
});
