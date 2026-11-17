import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from 'playwright/test';

const base = process.env.LIVENOTE_TEST_URL;
if (!base) throw new Error('Задайте LIVENOTE_TEST_URL отдельного vault-сервера.');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

test('Plain Markdown opens directly in Live Preview without properties or whole-source textarea', { timeout: 90_000 }, async () => {
  const id = `Smoke/${Date.now()}-Smoke.md`;
  const created = await fetch(`${base}/api/pages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Smoke', path: id, source: '# Plain\n\nБез YAML и служебных ID.\n' }) });
  assert.equal(created.status, 200, await created.text());
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(base);
    await page.locator('.vault-tree__page').filter({ hasText: 'Smoke' }).click();
    await expect(page.locator(`.vault-document[data-page-id="${id}"] .cm-content`)).toContainText('Без YAML и служебных ID.');
    await expect(page.locator('.vault-properties')).toHaveCount(0);
    await expect(page.locator('textarea')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Редактировать Markdown' })).toHaveCount(0);
  } finally {
    await context.close();
    const response = await fetch(`${base}/api/pages/${encodeURIComponent(id)}/document`);
    const { document } = await response.json();
    await fetch(`${base}/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: document.page.revision, expectedVersion: document.version }) });
  }
});
