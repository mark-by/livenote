import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from 'playwright/test';

const base = process.env.LIVENOTE_TEST_URL;
if (!base) throw new Error('Задайте LIVENOTE_TEST_URL отдельного vault-сервера.');
const screenshots = process.env.LIVENOTE_SCREENSHOT_DIR;
let browser;
let sequence = 0;

before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  if (screenshots) await mkdir(screenshots, { recursive: true });
});
after(async () => { await browser?.close(); });

async function api(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const tokens = (document) => ({ expectedRevision: document.page.revision, expectedVersion: document.version });
const getDocument = async (id) => (await api(`/pages/${encodeURIComponent(id)}/document`)).document;

async function fixture(t, source = '# Заголовок\n\nТекст заметки с **акцентом** и #тег.\n\n- первый пункт\n- второй пункт\n\n> Цитата.\n') {
  const suffix = `shell-${Date.now()}-${sequence++}`;
  const id = `Fixtures/${suffix}/${suffix}.md`;
  await api('/pages', 'POST', { title: suffix, path: id, source });
  t.after(async () => {
    const snapshot = await api('/vault');
    for (const file of snapshot.files.filter((item) => item.path.includes(suffix))) {
      await api(`/pages/${encodeURIComponent(file.path)}`, 'DELETE', { expectedRevision: file.revision, expectedVersion: file.version }, 204);
    }
    const current = await api('/vault');
    const folder = `Fixtures/${suffix}`;
    if (current.folders.includes(folder)) await api('/vault/folders', 'DELETE', { path: folder, expectedTreeVersion: current.treeVersion, recursive: true });
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  t.after(() => context.close());
  await page.goto(base);
  await page.locator('.vault-tree__page').filter({ hasText: suffix }).click();
  await expect(page.locator(`.vault-document[data-page-id="${id}"] .cm-content`)).toBeVisible();
  return { page, id, suffix };
}

async function shot(page, name) {
  if (screenshots) await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}

async function insert(page, format) {
  await page.locator('.vault-document:not([hidden]) .vault-document__actions button[aria-label="Вставить диаграмму"]').click();
  await page.getByRole('menuitem', { name: 'Вставить диаграмму' }).hover();
  const label = format === 'mermaid' ? 'Mermaid' : format === 'bpmn' ? 'BPMN' : format === 'drawio' ? 'draw.io' : format;
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

async function diagramDialog(page, format) {
  return page.locator(format === 'bpmn' ? '.bpmn-editor-dialog' : format === 'drawio' ? '.drawio-fullscreen' : '.diagram-fullscreen');
}

test('Live Preview, safe links, inline rename and #tags persist through real REST', { timeout: 120_000 }, async (t) => {
  const otherSource = '# Другая заметка\n';
  const { page, id, suffix } = await fixture(t, `# Проверка\n\n[Другая](Other.md)\n\n[Опасная](javascript:window.__unsafe=1)\n`);
  const otherId = `Fixtures/${suffix}/Other.md`;
  await api('/pages', 'POST', { title: 'Other', path: otherId, source: otherSource });
  await page.reload();
  await page.locator('.vault-tree__page').filter({ hasText: suffix }).click();
  await page.evaluate(() => { window.__unsafe = 0; });
  await page.keyboard.down('Meta');
  await page.locator('.lp-link').filter({ hasText: 'Опасная' }).click();
  await page.keyboard.up('Meta');
  assert.equal(await page.evaluate(() => window.__unsafe), 0);
  await page.keyboard.down('Meta');
  await page.locator('.lp-link').filter({ hasText: 'Другая' }).click();
  await page.keyboard.up('Meta');
  await expect(page.locator(`.vault-document[data-page-id="${otherId}"]`)).toBeVisible();
  await page.locator('.vault-document-tabs [role="tab"]').filter({ hasText: suffix }).click();
  await page.locator(`.vault-document[data-page-id="${id}"] .vault-title-field input`).fill('Renamed');
  await page.locator(`.vault-document[data-page-id="${id}"] .vault-title-field input`).press('Enter');
  const renamed = id.replace(`${suffix}.md`, 'Renamed.md');
  await expect(page.locator(`.vault-document[data-page-id="${renamed}"]`)).toBeVisible();
  await expect(page.locator('.vault-inline-tags')).toHaveCount(0);
  await page.locator(`.vault-document[data-page-id="${renamed}"] .cm-content`).click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.type('\n\n#проверено');
  await expect.poll(async () => (await getDocument(renamed)).tags).toContain('проверено');
});

test('Typing during one in-flight save is visible and persisted by the next request', { timeout: 120_000 }, async (t) => {
  const { page, id } = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let delayed = false;
  let writes = 0;
  await page.route('**/api/pages/*/document', async (route) => {
    if (route.request().method() === 'PUT') {
      writes++;
      if (!delayed) { delayed = true; startedResolve(); await gate; }
    }
    await route.continue();
  });
  const editor = page.locator(`.vault-document[data-page-id="${id}"] .cm-content`);
  await editor.click(); await page.keyboard.press('Meta+End'); await page.keyboard.type('\n\nALPHA.');
  await started;
  await expect(editor).toBeFocused();
  await page.keyboard.type(' BETA.');
  await expect.poll(() => editor.textContent()).toContain('ALPHA. BETA.');
  release();
  await expect.poll(async () => (await getDocument(id)).source).toContain('ALPHA. BETA.');
  await expect.poll(() => editor.textContent()).toContain('ALPHA. BETA.');
  assert.equal(writes, 2);
});

test('External 409 keeps local draft and external file without further autosave', { timeout: 120_000 }, async (t) => {
  const { page, id } = await fixture(t);
  const before = await getDocument(id);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let delayed = false;
  await page.route('**/api/pages/*/document', async (route) => {
    if (route.request().method() === 'PUT' && !delayed) { delayed = true; startedResolve(); await gate; }
    await route.continue();
  });
  const editor = page.locator(`.vault-document[data-page-id="${id}"] .cm-content`);
  await editor.click(); await page.keyboard.press('Meta+End'); await page.keyboard.type('\n\nLOCAL.');
  await started;
  await api(`/pages/${encodeURIComponent(id)}/document`, 'PUT', { ...tokens(before), source: `${before.source}\n\nEXTERNAL.` });
  release();
  await expect(page.getByRole('alert').filter({ hasText: 'Автосохранение остановлено' })).toBeVisible();
  await expect(editor).toContainText('LOCAL.');
  assert.match((await getDocument(id)).source, /EXTERNAL\.$/);
  assert.doesNotMatch((await getDocument(id)).source, /LOCAL\./);
  await expect(page.getByRole('button', { name: 'Скачать черновик' })).toBeVisible();
});

test('All diagram formats cancel without writes, save atomically, embed existing files and open standalone', { timeout: 240_000 }, async (t) => {
  const { page, id, suffix } = await fixture(t);
  for (const format of ['mermaid', 'bpmn', 'drawio']) {
    const beforeFiles = (await api('/vault')).files.length;
    await insert(page, format);
    const dialog = await diagramDialog(page, format);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal((await api('/vault')).files.length, beforeFiles);
    await insert(page, format);
    const create = await diagramDialog(page, format);
    await expect(create).toBeVisible();
    await create.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(create).toHaveCount(0, { timeout: 30_000 });
    if (format === 'mermaid') await expect.poll(async () => (await getDocument(id)).source).toContain('```mermaid');
    else await expect.poll(async () => (await getDocument(id)).assets.some((asset) => asset.path.includes(suffix) && asset.path.endsWith(`.${format}`))).toBe(true);
  }
  await expect(page.locator('.vault-document:not([hidden]) .mermaid-block svg.flowchart').first()).toBeVisible();
  await expect(page.locator('.vault-document:not([hidden]) .bpmn-block .djs-container').first()).toBeVisible();
  await shot(page, 'desktop-light');
  await insert(page, 'Существующий файл');
  const picker = page.getByRole('dialog', { name: 'Выбрать файл схемы' });
  await expect(picker).toBeVisible();
  await picker.getByRole('option').filter({ hasText: `${suffix} — Процесс` }).click();
  await expect(picker).toHaveCount(0);
  const document = await getDocument(id);
  assert.ok(document.assets.length >= 2);
  await expect.poll(async () => (await getDocument(id)).source.split(`Схемы/${suffix} — Процесс.bpmn`).length - 1).toBeGreaterThanOrEqual(2);
  await insert(page, 'Существующий файл');
  await page.getByRole('dialog', { name: 'Выбрать файл схемы' }).getByRole('option').filter({ hasText: `${suffix} — Процесс` }).click();
  await expect.poll(async () => (await getDocument(id)).source.split(`Схемы/${suffix} — Процесс.bpmn`).length - 1).toBe(3);
  const asset = document.assets.find((item) => item.path.endsWith('.bpmn'));
  assert.ok(asset);
  const beforeUnlink = await getDocument(id);
  const embeds = [...beforeUnlink.source.matchAll(/!\[\[[^\]\n]*\.bpmn[^\]\n]*\]\]/g)];
  assert.equal(embeds.length, 3);
  assert.equal(embeds[1][0], embeds[2][0]);
  const token = embeds[2][0];
  const lastEmbed = embeds[2].index;
  const withoutLastEmbed = `${beforeUnlink.source.slice(0, lastEmbed)}${beforeUnlink.source.slice(lastEmbed + token.length)}`;
  const scroller = page.locator(`.vault-document[data-page-id="${id}"] .cm-scroller`);
  for (const embed of embeds) {
    const preview = page.locator(`.lp-diagram[data-from="${embed.index}"] .bpmn-block`);
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    for (let step = 0; step < 30 && !await preview.isVisible(); step++) {
      const moved = await scroller.evaluate(async (element) => {
        const previous = element.scrollTop;
        element.scrollTop += element.clientHeight / 2;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return element.scrollTop > previous;
      });
      if (!moved) break;
    }
    await expect(preview).toBeVisible();
  }
  const lastPreview = page.locator(`.lp-diagram[data-from="${lastEmbed}"]`);
  await lastPreview.getByRole('button', { name: 'Удалить диаграмму' }).click();
  await expect.poll(async () => (await getDocument(id)).source).toBe(withoutLastEmbed);
  assert.equal((await getDocument(asset.path)).source, asset.source);
  await page.locator(`.vault-document[data-page-id="${id}"] .cm-content`).focus();
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await getDocument(id)).source).toBe(beforeUnlink.source);
  const restored = page.locator(`.lp-diagram[data-from="${lastEmbed}"]`);
  await restored.scrollIntoViewIfNeeded();
  await expect(restored.locator('.bpmn-block')).toBeVisible();
  await shot(page, 'diagram-undo');
  await restored.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Удалить диаграмму', exact: true }).click();
  await expect.poll(async () => (await getDocument(id)).source).toBe(withoutLastEmbed);
  assert.equal((await getDocument(asset.path)).source, asset.source);
  await page.locator('.vault-tree__page').filter({ hasText: `${suffix} — Процесс` }).click();
  await expect(page.locator('.vault-standalone-diagram')).toBeVisible();
});

test('Rejected diagram Save stays open and retries with the same valid base', { timeout: 120_000 }, async (t) => {
  const { page, id } = await fixture(t);
  await insert(page, 'mermaid');
  const dialog = await diagramDialog(page, 'mermaid');
  await expect(dialog).toBeVisible();
  let rejected = false;
  await page.route('**/api/pages/*/document', async (route) => {
    if (route.request().method() === 'PUT' && !rejected) {
      rejected = true;
      await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'diagram_invalid', message: 'Исправьте схему' } }) });
      return;
    }
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toContainText('Исправьте схему');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  assert.match((await getDocument(id)).source, /```mermaid/);
});

test('Empty folder create, selected-folder note, folder move and recursive delete use native APIs', { timeout: 120_000 }, async (t) => {
  const { page, suffix } = await fixture(t);
  await page.locator('.vault-tree__folder-trigger').filter({ hasText: suffix }).click();
  await page.locator('.vault-sidebar').getByRole('button', { name: 'Создать', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Папка', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Имя элемента' });
  await expect(name).toHaveValue('Новая папка');
  await name.fill('Empty');
  await name.press('Enter');
  await expect(page.locator('.vault-tree__folder-trigger').filter({ hasText: 'Empty' })).toBeVisible();
  await page.locator('.vault-tree__folder-trigger').filter({ hasText: 'Empty' }).click();
  await page.locator('.vault-sidebar').getByRole('button', { name: 'Создать', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Файл', exact: true }).click();
  await expect(name).toHaveValue('Новая заметка');
  await name.fill('Inside');
  await name.press('Enter');
  await expect(page.locator('.vault-document:not([hidden]) .vault-title-field input')).toHaveValue('Inside');
  const movedId = `Fixtures/${suffix}/Empty/Inside.md`;
  assert.equal((await getDocument(movedId)).path, movedId);
  await page.locator('.vault-tree__folder-row').filter({ hasText: 'Empty' }).locator('button[aria-label="Действия с папкой Empty"]').click();
  await page.getByRole('menuitem', { name: 'Переместить', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Переместить' });
  await dialog.getByRole('textbox', { name: 'Путь' }).fill(`Fixtures/${suffix}/Moved`);
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('.vault-document:not([hidden]) .vault-title-field input')).toHaveValue('Inside');
  assert.equal((await getDocument(`Fixtures/${suffix}/Moved/Inside.md`)).path, `Fixtures/${suffix}/Moved/Inside.md`);
  await page.locator('.vault-tree__folder-row').filter({ hasText: 'Moved' }).locator('button[aria-label="Действия с папкой Moved"]').click();
  await page.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить папку?' });
  await confirmation.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await api(`/pages/${encodeURIComponent(`Fixtures/${suffix}/Moved/Inside.md`)}/document`, 'GET', undefined, 404);
});

test('Tree context creation, collision drafts and drag moves preserve files', { timeout: 120_000 }, async (t) => {
  const { page, id, suffix } = await fixture(t);
  const referenceId = `Fixtures/${suffix}/Reference.md`;
  await api('/pages', 'POST', { title: 'Reference', path: referenceId, source: `[[${suffix}.md]]` });
  await page.reload();
  await expect(page.locator('.vault-tree__page').filter({ hasText: 'Reference' })).toBeVisible();
  const folder = page.locator('.vault-tree__folder-row').filter({ has: page.locator('.vault-tree__folder-trigger', { hasText: suffix }) });
  await folder.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Создать', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Папка', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Имя элемента' });
  await expect(name).toHaveValue('Новая папка');
  await name.fill('Nested');
  await name.press('Enter');
  const nested = page.locator('.vault-tree__folder-row').filter({ has: page.locator('.vault-tree__folder-trigger', { hasText: 'Nested' }) });
  await expect(nested).toBeVisible();
  const file = page.locator('.vault-tree__file').filter({ hasText: suffix });
  await file.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Создать', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Файл', exact: true }).click();
  await expect(name).toHaveValue('Новая заметка');
  await name.press('Escape');
  const defaultId = `Fixtures/${suffix}/Новая заметка.md`;
  assert.equal((await getDocument(defaultId)).path, defaultId);
  await file.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Создать', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Файл', exact: true }).click();
  await expect(name).toHaveValue('Новая заметка 2');
  await name.press('Escape');
  assert.equal((await getDocument(`Fixtures/${suffix}/Новая заметка 2.md`)).path, `Fixtures/${suffix}/Новая заметка 2.md`);
  await file.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Переименовать', exact: true }).click();
  await name.fill('Новая заметка');
  await name.press('Enter');
  await expect(name).toHaveValue('Новая заметка');
  await expect(page.getByRole('alert')).toBeVisible();
  await name.press('Escape');
  assert.equal((await getDocument(id)).path, id);
  await file.locator('.vault-tree__page').click();
  await file.dragTo(nested);
  const nestedId = `Fixtures/${suffix}/Nested/${suffix}.md`;
  await expect.poll(async () => (await api('/vault')).files.some((entry) => entry.path === nestedId)).toBe(true);
  await expect.poll(async () => (await getDocument(referenceId)).links[0]?.targetPageId).toBe(nestedId);
  await expect(page.locator(`.vault-document[data-page-id="${nestedId}"]`)).toBeVisible();
  const moved = page.locator('.vault-tree__file').filter({ hasText: suffix });
  await moved.dragTo(page.getByRole('button', { name: 'Хранилище' }));
  const rootId = `${suffix}.md`;
  await expect.poll(async () => (await api('/vault')).files.some((entry) => entry.path === rootId)).toBe(true);
  await expect.poll(async () => (await getDocument(referenceId)).links[0]?.targetPageId).toBe(rootId);
  await folder.dragTo(nested);
  assert.ok((await api('/vault')).folders.includes(`Fixtures/${suffix}/Nested`));
  await folder.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Создать', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Папка', exact: true }).click();
  await name.fill('Destination');
  await name.press('Enter');
  const destination = page.locator('.vault-tree__folder-row').filter({ has: page.locator('.vault-tree__folder-trigger', { hasText: 'Destination' }) });
  await expect(destination).toBeVisible();
  await nested.dragTo(destination);
  await expect.poll(async () => (await api('/vault')).folders.includes(`Fixtures/${suffix}/Destination/Nested`)).toBe(true);
  await shot(page, 'tree-context-drag');
});

test('Dragging a file while its draft is saving keeps the draft and file in place', { timeout: 120_000 }, async (t) => {
  const { page, id, suffix } = await fixture(t);
  const snapshot = await api('/vault');
  await api('/vault/folders', 'POST', { path: `Fixtures/${suffix}/Target`, expectedTreeVersion: snapshot.treeVersion });
  await page.reload();
  const target = page.locator('.vault-tree__folder-row').filter({ has: page.locator('.vault-tree__folder-trigger', { hasText: 'Target' }) });
  await expect(target).toBeVisible();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  await page.route('**/api/pages/*/document', async (route) => {
    if (route.request().method() === 'PUT') { startedResolve(); await gate; }
    await route.continue();
  });
  try {
    const editor = page.locator(`.vault-document[data-page-id="${id}"] .cm-content`);
    await editor.click();
    await page.keyboard.press('Meta+End');
    await page.keyboard.type('\n\nLOCAL DRAFT');
    await started;
    await page.locator('.vault-tree__file').filter({ hasText: suffix }).dragTo(target);
    await expect(page.getByRole('alert')).toContainText('черновиков');
    await expect(editor).toContainText('LOCAL DRAFT');
    assert.equal((await getDocument(id)).path, id);
  } finally { release(); }
  await expect.poll(async () => (await getDocument(id)).source).toContain('LOCAL DRAFT');
});

test('Mobile tree, persistent Vim and dark theme remain usable without horizontal overflow', { timeout: 120_000 }, async (t) => {
  const { page } = await fixture(t);
  await page.locator('.vault-topbar button[aria-label="Меню LiveNote"]').click();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Настройки' });
  const vimSwitch = settings.getByRole('switch', { name: 'Vim mode' });
  await settings.getByText('Vim mode', { exact: true }).click();
  await expect(vimSwitch).toBeChecked();
  await vimSwitch.press('Space');
  await expect(vimSwitch).not.toBeChecked();
  await vimSwitch.press('Space');
  await expect(vimSwitch).toBeChecked();
  await settings.getByRole('button', { name: 'Готово' }).click();
  const mode = page.locator('.vault-document:not([hidden]) .lp-mode');
  await expect(mode).toContainText('Vim');
  await page.reload();
  await expect(mode).toContainText('Vim');
  await page.locator('.vault-document:not([hidden]) .cm-content').click();
  await page.keyboard.press('i');
  await expect(mode).toContainText('Insert');
  await page.keyboard.press('Escape');
  await expect(mode).toContainText('Normal');
  await page.keyboard.press('v');
  await expect(mode).toContainText('Visual');
  await page.locator('.vault-topbar button[aria-label="Меню LiveNote"]').click();
  await page.getByRole('menuitem', { name: 'Тёмная тема', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'mobile-dark');
  await page.getByRole('button', { name: 'Открыть дерево заметок' }).click();
  await expect(page.getByRole('dialog', { name: 'Дерево заметок' })).toBeVisible();
  await shot(page, 'mobile-tree-dark');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
