import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium, expect } from 'playwright/test';
import { createApp } from '../dist/server/app.js';

async function assertDrawingFits(svg) {
  const bounds = await svg.evaluate(element => {
    const box = element.getBBox();
    const view = element.viewBox.baseVal;
    return { x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height,
      viewX: view.x, viewY: view.y, viewRight: view.x + view.width, viewBottom: view.y + view.height,
      width: box.width, height: box.height };
  });
  assert.ok(bounds.width > 0 && bounds.height > 0);
  assert.ok(bounds.x >= bounds.viewX && bounds.y >= bounds.viewY);
  assert.ok(bounds.right <= bounds.viewRight && bounds.bottom <= bounds.viewBottom);
}

test('Диаграмма последовательности отображается после открытия блок-схемы в другой вкладке', { timeout: 90_000 }, async t => {
  // Arrange: создаём отдельное хранилище с двумя разными диаграммами.
  const directory = await mkdtemp(join(tmpdir(), 'livenote-mermaid-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '00-flow.md'), '# Flow\n\n```mermaid\nflowchart TB\n  A{Flow decision} --> B[Flow result]\n```\n');
  await writeFile(join(directory, '01-sequence.md'), '# Sequence\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: Sequence message\n```\n');
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
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('.vault-tree__page').filter({ hasText: '00-flow' }).click();
  const flow = page.locator('.vault-document:not([hidden]) .mermaid-block > div:not([class]) > svg');
  await expect(flow).toContainText('Flow decision');
  const flowId = await flow.getAttribute('id');

  // Act: открываем диаграмму последовательности, сохраняя первую вкладку.
  await page.locator('.vault-tree__page').filter({ hasText: '01-sequence' }).click();
  const sequence = page.locator('.vault-document:not([hidden]) .mermaid-block > div:not([class]) > svg');
  await expect(sequence).toBeAttached();

  // Assert: вторая схема содержит своё сообщение и имеет ненулевую область рисунка.
  await expect(sequence).toContainText('Sequence message');
  await expect(sequence).not.toContainText('Flow decision');
  const sequenceId = await sequence.getAttribute('id');
  assert.notEqual(flowId, sequenceId);
  await assertDrawingFits(sequence);

  // Assert: первая схема после возврата сохраняет свои элементы без линий второй схемы.
  await page.locator('.vault-document-tabs [role="tab"]').filter({ hasText: '00-flow' }).click();
  await expect(flow).toContainText('Flow decision');
  await expect(flow).not.toContainText('Sequence message');
  await expect(flow.locator('.actor-line')).toHaveCount(0);
  await assertDrawingFits(flow);
});
