import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from 'playwright/test';

const base = process.env.LIVENOTE_TEST_URL;
if (!base) throw new TypeError('Задайте URL изолированного сервера.');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, query) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  t.after(() => context.close());
  const page = await context.newPage();
  const writes = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && path !== '/api/config') writes.push(request.url());
  });
  await page.goto(`${base}/diagram-adapter-harness?${query}`);
  await expect(page.getByRole('heading', { name: 'Проверка адаптера' })).toBeVisible();
  return { page, writes };
}

for (const model of [
  { query: '', label: 'Подпись узла', text: 'Новый узел', selection: 'Начало' },
  { query: 'class=1', label: 'Подпись класса', text: 'Новый класс', selection: 'Item' }
]) {
  test(`Mermaid callback сохраняет ${model.label} после отклонённой записи без HTTP mutations`, { timeout: 60_000 }, async (t) => {
    const { page, writes } = await fixture(t, `${model.query}&reject=1`);
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    const dialog = page.getByRole('dialog').first();
    await dialog.locator('.node').filter({ hasText: model.selection }).first().click();
    await page.getByLabel(model.label, { exact: true }).fill(model.text);
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Конфликт документа');
    await expect(page.getByLabel(model.label, { exact: true })).toHaveValue(model.text);
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Скачать SVG', exact: true }).click();
    assert.match(await readFile(await (await download).path(), 'utf8'), new RegExp(model.text));
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('Сохранённый исходник')).toContainText(model.text);
    assert.deepEqual(writes, []);
  });
}

test('Mermaid Cancel оставляет исходник и не вызывает callback; local SVG/source/copy работают', { timeout: 60_000 }, async (t) => {
  const { page, writes } = await fixture(t, '');
  const original = await page.getByLabel('Сохранённый исходник').textContent();
  const preview = page.locator('.diagram-adapter');
  await preview.hover();
  await preview.getByRole('button', { name: 'Копировать исходник', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), original);
  const downloaded = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Скачать SVG', exact: true }).click();
  assert.match(await readFile(await (await downloaded).path(), 'utf8'), /<svg/);
  await expect(preview.getByRole('button', { name: 'Скачать PNG' })).toHaveCount(0);
  await preview.getByRole('button', { name: 'Редактировать диаграмму' }).click();
  const dialog = page.getByRole('dialog').first();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Попытки сохранения')).toHaveText('0');
  await expect(page.getByLabel('Сохранённый исходник')).toHaveText(original);
  assert.deepEqual(writes, []);
});

test('draw.io callback получает свежий незавершённый текст и сохраняет iframe после отказа', { timeout: 120_000 }, async (t) => {
  const { page, writes } = await fixture(t, 'format=drawio&reject=1');
  await expect(page.locator('.drawio-preview__image')).toBeVisible({ timeout: 45_000 });
  const background = await page.locator('.drawio-frame-host').elementHandle();
  const backgroundFrame = await background.contentFrame();
  let backgroundLoads = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === backgroundFrame &&
      request.url().includes('/drawio/index.html')) backgroundLoads++;
  });
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  const dialog = page.getByRole('dialog').first();
  const frame = dialog.locator('iframe').contentFrame();
  await frame.locator('.geDiagramContainer').waitFor({ timeout: 45_000 });
  await frame.getByText('Начало', { exact: true }).first().dblclick();
  const cell = frame.locator('.mxCellEditor[contenteditable="true"]:visible');
  await expect(cell).toBeFocused();
  await page.keyboard.type('Свежий XML');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Конфликт документа');
  await expect(frame.locator('.geDiagramContainer')).toContainText('Свежий XML');
  assert.equal(backgroundLoads, 0, 'Открытый dialog не перезагружает фоновый preview.');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Сохранённый исходник')).toContainText('Свежий XML');
  assert.deepEqual(writes, []);
});

test('Создание draw.io отменяется без записи; iframe сохраняет фокус в StrictMode', { timeout: 120_000 }, async (t) => {
  const { page, writes } = await fixture(t, 'format=drawio');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const dialog = page.getByRole('dialog').first();
  const frame = dialog.locator('iframe').contentFrame();
  await frame.locator('.geDiagramContainer').waitFor({ timeout: 45_000 });
  await frame.getByText('Начало', { exact: true }).first().dblclick();
  await expect(frame.locator('.mxCellEditor[contenteditable="true"]:visible')).toBeFocused();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Попытки сохранения')).toHaveText('0');
  assert.deepEqual(writes, []);
});

test('draw.io Save без изменений возвращает исходные XML bytes через callback', { timeout: 120_000 }, async (t) => {
  const { page, writes } = await fixture(t, 'format=drawio');
  const source = await page.getByLabel('Сохранённый исходник').textContent();
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled({ timeout: 45_000 });
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Сохранённый исходник')).toHaveText(source);
  assert.deepEqual(writes, []);
});
