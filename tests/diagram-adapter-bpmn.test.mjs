import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from 'playwright/test';

const base = process.env.LIVENOTE_TEST_URL;
if (!base) throw new TypeError('Задайте URL изолированного сервера.');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, query = '', mode = 'Создать') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  t.after(async () => {
    if (process.env.LIVENOTE_DIAGRAM_EVIDENCE) {
      await page.screenshot({ path: join(process.env.LIVENOTE_DIAGRAM_EVIDENCE, 'bpmn-last-state.png') });
    }
    await context.close();
  });
  const writes = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url());
  });
  await page.goto(`${base}/diagram-adapter-harness?format=bpmn&${query}`);
  await page.getByRole('button', { name: mode, exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (mode === 'Открыть') {
    await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeEnabled();
  } else {
    await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled();
    await expect(dialog.locator('.djs-palette')).toBeVisible();
  }
  return { page, dialog, writes };
}

test('BPMN Modeler создаёт task/event/connect, переименовывает, двигает и сохраняет свежие XML/DI после отказа', { timeout: 90_000 }, async (t) => {
  const { page, dialog, writes } = await fixture(t, 'reject=1');
  const canvas = dialog.locator('.bpmn-editor-canvas');
  await dialog.locator('[data-action="create.task"]').click();
  const area = await canvas.boundingBox();
  assert.ok(area);
  await page.mouse.click(area.x + area.width * 0.55, area.y + area.height * 0.45);
  const task = dialog.locator('.djs-shape[data-element-id^="Activity_"]');
  await expect(task).toHaveCount(1);
  await dialog.locator('.djs-direct-editing-content').fill('Приёмка');
  await page.keyboard.press('Enter');
  await dialog.locator('[data-action="create.end-event"]').click();
  await page.mouse.click(area.x + area.width * 0.75, area.y + area.height * 0.45);
  const end = dialog.locator('.djs-shape[data-element-id^="Event_"]');
  await expect(end).toHaveCount(1);
  await canvas.click({ position: { x: area.width * 0.6, y: area.height * 0.75 } });
  await task.click();
  await expect(task).toHaveClass(/selected/);
  await expect(dialog.locator('.djs-context-pad [data-action="append.append-task"]')).toBeVisible();
  const endBounds = await end.boundingBox();
  assert.ok(endBounds);
  await dialog.locator('.djs-context-pad [data-action="connect"]').click();
  await page.mouse.move(endBounds.x + endBounds.width / 2, endBounds.y + endBounds.height / 2, { steps: 10 });
  await end.click();
  await expect(dialog.locator('.djs-connection')).toHaveCount(1);
  const beforeMove = await task.boundingBox();
  assert.ok(beforeMove);
  await page.mouse.move(beforeMove.x + 30, beforeMove.y + 20);
  await page.mouse.down();
  await page.mouse.move(beforeMove.x + 130, beforeMove.y + 100, { steps: 8 });
  await page.mouse.up();
  const moved = await task.boundingBox();
  assert.ok(moved);
  assert.ok(moved.y > beforeMove.y + 50);
  await dialog.getByRole('button', { name: 'Отменить действие', exact: true }).click();
  await expect.poll(async () => Math.round((await task.boundingBox()).y)).toBe(Math.round(beforeMove.y));
  await dialog.getByRole('button', { name: 'Повторить действие', exact: true }).click();
  await expect.poll(async () => Math.round((await task.boundingBox()).y)).toBe(Math.round(moved.y));
  await task.dblclick();
  await dialog.locator('.djs-direct-editing-content').fill('Свежая приёмка');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Конфликт документа');
  await expect(task).toContainText('Свежая приёмка');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Скачать SVG', exact: true }).click();
  const svg = await readFile(await (await download).path(), 'utf8');
  const labels = await page.evaluate((source) => [...new DOMParser().parseFromString(source, 'image/svg+xml')
    .querySelectorAll('.djs-label')].map((element) => element.textContent), svg);
  assert.deepEqual(labels, ['Свежая приёмка']);
  if (process.env.LIVENOTE_DIAGRAM_EVIDENCE) {
    await mkdir(process.env.LIVENOTE_DIAGRAM_EVIDENCE, { recursive: true });
    await page.screenshot({ path: join(process.env.LIVENOTE_DIAGRAM_EVIDENCE, 'bpmn-modeler-desktop.png') });
  }
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const xml = await page.getByLabel('Сохранённый исходник').textContent();
  assert.match(xml, /<bpmn:task[^>]+name="Свежая приёмка"/);
  assert.match(xml, /<bpmn:endEvent/);
  assert.match(xml, /<bpmn:sequenceFlow/);
  assert.match(xml, /<bpmndi:BPMNShape/);
  await expect(page.locator('.bpmn-block .djs-shape').filter({ hasText: 'Свежая приёмка' })).toHaveCount(1);
  assert.deepEqual(writes, []);
});

test('BPMN Cancel не публикует starter и не вызывает callback', { timeout: 60_000 }, async (t) => {
  const { page, dialog, writes } = await fixture(t);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Сохранённый исходник')).toHaveText('');
  await expect(page.getByLabel('Попытки сохранения')).toHaveText('0');
  assert.deepEqual(writes, []);
});

test('BPMN Save без изменений сохраняет точные XML bytes, комментарий и CRLF', { timeout: 60_000 }, async (t) => {
  const { page, dialog, writes } = await fixture(t, 'existing=1', 'Редактировать');
  const source = await page.getByLabel('Сохранённый исходник').textContent();
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(await page.getByLabel('Сохранённый исходник').textContent(), source);
  assert.deepEqual(writes, []);
});

test('BPMN fullscreen сохраняет viewer до явного перехода в Modeler', { timeout: 60_000 }, async (t) => {
  const { page, dialog, writes } = await fixture(t, 'existing=1', 'Открыть');
  await expect(dialog.locator('.bpmn-view-host')).toBeVisible();
  await expect(dialog.locator('.djs-palette')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await expect(dialog.locator('.djs-palette')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Попытки сохранения')).toHaveText('0');
  assert.deepEqual(writes, []);
});
