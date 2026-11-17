import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from 'playwright/test';

const base = process.env.LIVENOTE_TEST_URL;
if (!base) throw new TypeError('Задайте URL изолированного сервера.');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, query) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const writes = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && path !== '/api/config') writes.push(request.url());
  });
  await page.goto(`${base}/diagram-adapter-harness?sequence=1&${query}`);
  await expect(page.getByRole('heading', { name: 'Проверка адаптера' })).toBeVisible();
  return { page, writes };
}

test('sequenceDiagram редактируется с live preview, удерживает отклонённый Save и сохраняет исправленный исходник', { timeout: 60_000 }, async (t) => {
  const { page, writes } = await fixture(t, 'reject=1');
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  const dialog = page.getByRole('dialog').first();
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  const source = dialog.getByLabel('Исходник Mermaid', { exact: true });
  const first = 'sequenceDiagram\nAlice->>Bob: Первая версия';
  await source.fill(first);
  await expect(dialog.locator('.diagram-fullscreen__svg')).toContainText('Первая версия');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Конфликт документа');
  await expect(source).toHaveValue(first);
  await expect(page.getByLabel('Попытки сохранения')).toHaveText('1');
  await source.fill('sequenceDiagram\nAlice ->>>');
  await expect(dialog.getByRole('alert')).toContainText('Ошибка рендера');
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
  await source.press('ControlOrMeta+s');
  await expect(page.getByLabel('Попытки сохранения')).toHaveText('1');
  const corrected = 'sequenceDiagram\nAlice->>Bob: Исправлено после конфликта';
  await source.fill(corrected);
  await expect(dialog.locator('.diagram-fullscreen__svg')).toContainText('Исправлено после конфликта');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Сохранённый исходник')).toHaveText(corrected);
  await expect(page.getByLabel('Попытки сохранения')).toHaveText('2');
  assert.deepEqual(writes, []);
});

test('sequenceDiagram сразу открывает source editor; Cancel отменяет черновик без записи', { timeout: 60_000 }, async (t) => {
  const { page, writes } = await fixture(t, '');
  const original = await page.getByLabel('Сохранённый исходник').textContent();
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  const dialog = page.getByRole('dialog').first();
  await dialog.getByLabel('Исходник Mermaid', { exact: true }).fill('sequenceDiagram\nAlice->>Bob: Не сохранять');
  await expect(dialog.locator('.diagram-fullscreen__svg')).toContainText('Не сохранять');
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Отменить изменения?' });
  await confirm.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Сохранённый исходник')).toHaveText(original);
  await expect(page.getByLabel('Попытки сохранения')).toHaveText('0');
  await expect(page.getByLabel('Отмены')).toHaveText('1');
  assert.deepEqual(writes, []);
});
