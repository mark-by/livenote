import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from 'playwright/test';

const base = process.env.LIVENOTE_TEST_URL;
if (!base) throw new Error('Задайте LIVENOTE_TEST_URL отдельного тестового сервера.');
const testTimeout = 90_000;
const source = `<mxfile><diagram id="page-1" name="Первая"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="start" value="Начало" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="80" y="80" width="160" height="64" as="geometry"/></mxCell></root></mxGraphModel></diagram><diagram id="page-2" name="Вторая"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="other" value="Вторая страница" vertex="1" parent="1"><mxGeometry x="80" y="200" width="160" height="64" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
let browser;

before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); });

async function api(path, body, method = 'POST') {
  const response = await fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal(response.ok, true, await response.clone().text());
  return response.status === 204 ? null : response.json();
}

async function stored(id) {
  const { page } = await (await fetch(`${base}/api/pages/${id}`)).json();
  return page;
}

async function fixture(t, viewport = { width: 1440, height: 900 }) {
  const { page: created } = await api('/pages', { title: `draw.io ${crypto.randomUUID()}` });
  await api(`/pages/${created.id}/blocks`, {
    blockId: 'diagram', type: 'drawio', source, expectedRevision: created.revision
  });
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  t.after(async () => {
    await context.close();
    const current = await stored(created.id);
    await api(`/pages/${created.id}`, { expectedRevision: current.revision }, 'DELETE');
  });
  await page.goto(base);
  await page.getByRole('button', { name: created.title, exact: true }).click();
  await expect(page.locator('.drawio-preview__image')).toBeVisible({ timeout: 45_000 });
  await page.locator('.drawio-preview__image').evaluate((image) => image.decode());
  return { page, id: created.id, title: created.title };
}

async function openEditor(page) {
  await page.locator('.drawio-block').first().hover();
  await page.locator('.drawio-block').first().getByRole('button', { name: 'Во весь экран', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /— схема draw\.io$/ });
  await expect(dialog.locator('.drawio-fullscreen__frame')).toBeVisible();
  const frame = dialog.locator('.drawio-fullscreen__frame');
  await expect(frame).toHaveAttribute('src',
    '/drawio/index.html?embed=1&proto=json&offline=1&noSaveBtn=1&noExitBtn=1&saveAndExit=0&contrast=0&ui=simple&sidebar=0&format=0');
  await frame.contentFrame().locator('.geDiagramContainer').waitFor({ timeout: 45_000 });
  return { dialog, frame: frame.contentFrame() };
}

async function addText(page, dialog, text, finishEditing = false, newNode = false) {
  const frame = dialog.locator('.drawio-fullscreen__frame').contentFrame();
  const canvas = frame.locator('.geDiagramContainer');
  if (newNode) {
    await canvas.dblclick({ position: { x: 500, y: 400 } });
    // Первый double-click создаёт узел «Text»; второй открывает его редактор.
    await canvas.getByText('Text', { exact: true }).last().dblclick();
  } else {
    await canvas.getByText(/Начало/).first().dblclick();
  }
  const cellEditor = frame.locator('.mxCellEditor[contenteditable="true"]:visible');
  await cellEditor.waitFor();
  await expect(cellEditor).toBeFocused();
  await page.keyboard.type(text);
  if (finishEditing) {
    await page.keyboard.press('Escape');
    await expect(dialog.locator('.drawio-fullscreen__dirty')).toBeVisible();
  }
}

test('Preview использует Blob SVG первой страницы и локальный iframe с ненулевой геометрией', { timeout: testTimeout }, async (t) => {
  const { page } = await fixture(t);
  const image = page.locator('.drawio-preview__image');
  assert.match(await image.getAttribute('src'), /^blob:/);
  assert.equal(await page.locator('.drawio-preview__viewport svg').count(), 0, 'SVG не вставляется разметкой в LiveNote');
  const exportedSvg = await image.evaluate(async (element) => (await fetch(element.src)).text());
  assert.match(exportedSvg, /<svg[^>]+color-scheme: light;/,
    'SVG фиксирует светлую схему независимо от системной темы');
  const dimensions = await page.locator('.drawio-frame-host').evaluate((frame) => ({
    width: frame.getBoundingClientRect().width, height: frame.getBoundingClientRect().height
  }));
  assert.ok(dimensions.width > 0 && dimensions.height > 0);
  await page.locator('.drawio-block').hover();
  await page.locator('.drawio-block').getByRole('button', { name: 'Приблизить draw.io-схему' }).click();
  await expect(image).toHaveCSS('transform', /1\.2/);
  await page.locator('.drawio-block').getByRole('button', { name: 'Сбросить масштаб draw.io-схемы' }).click();
  await expect(image).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
});

test('Реальные export XML/SVG и серверный PNG скачиваются с правильным содержимым', { timeout: testTimeout }, async (t) => {
  const { page } = await fixture(t);
  const block = page.locator('.drawio-block');
  await block.hover();
  const xmlDownload = page.waitForEvent('download');
  await block.getByRole('button', { name: 'Скачать draw.io XML' }).click();
  const xml = await xmlDownload;
  assert.match(xml.suggestedFilename(), /\.drawio$/);
  assert.match(await readFile(await xml.path(), 'utf8'), /<mxfile>.*Первая.*Вторая/s);

  const { dialog } = await openEditor(page);
  const svgDownload = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Скачать SVG' }).click();
  const svg = await svgDownload;
  const svgText = await readFile(await svg.path(), 'utf8');
  assert.match(svgText, /<svg/);
  assert.match(svgText, /Начало/);
  assert.doesNotMatch(svgText, /Вторая страница/);

  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  const pngDownload = page.waitForEvent('download');
  await block.getByRole('button', { name: 'Скачать PNG' }).click();
  const png = await pngDownload;
  const bytes = await readFile(await png.path());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
});

test('Свежий XML сохраняется дважды, включая немедленно завершённый текст', { timeout: testTimeout }, async (t) => {
  const { page, id } = await fixture(t);
  const { dialog } = await openEditor(page);
  await addText(page, dialog, 'Первый черновик');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled();
  await expect.poll(async () => (await stored(id)).revision).toBe(3);
  await expect(dialog.locator('.drawio-fullscreen__frame').contentFrame()
    .locator('.mxCellEditor[contenteditable="true"]')).toHaveCount(0);
  assert.match((await stored(id)).blocks[0].source, /Первый черновик/);

  await addText(page, dialog, 'Второй черновик', false, true);
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled();
  await expect.poll(async () => (await stored(id)).revision).toBe(4);
  const saved = await stored(id);
  assert.match(saved.blocks[0].source, /Первый черновик/);
  assert.match(saved.blocks[0].source, /Второй черновик/);
  assert.equal(saved.revision, 4);
});

test('Cancel подтверждает dirty и не делает REST-запись', { timeout: testTimeout }, async (t) => {
  const { page, id } = await fixture(t);
  const { dialog } = await openEditor(page);
  await addText(page, dialog, 'Не сохранять', true);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal((await stored(id)).blocks[0].source, source);
  assert.equal((await stored(id)).revision, 2);
});

test('Конфликт оставляет редактор и черновик открытыми', { timeout: testTimeout }, async (t) => {
  const { page, id } = await fixture(t);
  const { dialog } = await openEditor(page);
  await addText(page, dialog, 'Мой черновик', true);
  await api(`/pages/${id}/blocks/diagram`, { source, expectedRevision: 2 }, 'PUT');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Черновик сохранён в редакторе');
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled();
  assert.equal((await stored(id)).revision, 3);
});

test('Добавление draw.io создаёт пустую схему; desktop и mobile не имеют переполнения', { timeout: testTimeout }, async (t) => {
  const { page } = await fixture(t, { width: 390, height: 844 });
  await page.getByRole('button', { name: 'Скрыть страницы', exact: true }).click();
  await page.getByRole('button', { name: '+ Добавить блок' }).click();
  await page.getByRole('button', { name: 'draw.io', exact: true }).click();
  await expect(page.locator('.drawio-block')).toHaveCount(2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const { dialog } = await openEditor(page);
  const bounds = await dialog.boundingBox();
  assert.equal(Math.round(bounds.width), 390);
  assert.equal(Math.round(bounds.height), 844);
  const canvasAvailable = await dialog.locator('.drawio-fullscreen__frame').contentFrame()
    .locator('.geDiagramContainer').evaluate((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return canvas.contains(canvas.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    });
  assert.equal(canvasAvailable, true, 'Панели draw.io не перекрывают центр холста на узком экране.');
  await page.screenshot();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
});
