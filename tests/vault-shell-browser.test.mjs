import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
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
const documentRoute = /\/api\/(?:vaults\/[^/]+\/)?pages\/[^/]+\/document$/;

async function fixture(t, source = '# Заголовок\n\nТекст заметки с **акцентом** и #тег.\n\n- первый пункт\n- второй пункт\n\n> Цитата.\n', { mermaidTheme } = {}) {
  const suffix = `shell-${Date.now()}-${sequence++}`;
  const id = `Fixtures/${suffix}/${suffix}.md`;
  await api('/pages', 'POST', { title: suffix, path: id, source });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (mermaidTheme) {
    await context.addInitScript((theme) => localStorage.setItem('livenote_mermaid_theme', theme), mermaidTheme);
  }
  t.after(async () => {
    await context.close();
    const snapshot = await api('/vault');
    const paths = snapshot.files.filter((item) => item.path.includes(suffix)).map((file) => file.path);
    for (const path of paths) {
      // Удаление документа может уже удалить его файлы схем.
      const file = (await api('/vault')).files.find((item) => item.path === path);
      if (!file) continue;
      await api(`/pages/${encodeURIComponent(file.path)}`, 'DELETE', { expectedRevision: file.revision, expectedVersion: file.version }, 204);
    }
    const current = await api('/vault');
    const folder = `Fixtures/${suffix}`;
    if (current.folders.includes(folder)) await api('/vault/folders', 'DELETE', { path: folder, expectedTreeVersion: current.treeVersion, recursive: true });
  });
  const page = await context.newPage();
  await page.goto(base);
  const navigation = page.getByRole('navigation', { name: 'Файлы хранилища' });
  await navigation.getByRole('button', { name: 'Fixtures', exact: true }).click();
  await navigation.getByRole('button', { name: suffix, exact: true }).click();
  await page.locator('.vault-tree__page').filter({ hasText: suffix }).click();
  await expect(page.locator(`.vault-document[data-page-id="${id}"] .cm-content`)).toBeVisible();
  return { page, id, suffix };
}

async function shot(page, name) {
  if (screenshots) await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true, animations: 'disabled' });
}

const documentTab = (page, title) => page.getByRole('tab').filter({ has: page.getByText(title, { exact: true }) });
const tabTitles = (page) => page.locator('[role="tab"] .vault-tab__label');
const tabsTimeout = 120_000;
const mermaidDownloadTimeout = 90_000;
const erDiagram = '# Схема\n\n```mermaid\nerDiagram\n  SECTOR {\n    int id PK\n    string name\n  }\n```\n';

async function allowImageClipboard(page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
  await page.evaluate(() => navigator.clipboard.writeText('Проверка буфера обмена'));
}

async function expectImageClipboard(page, filename) {
  const notification = page.getByRole('alertdialog', { name: 'Скачивание началось' });
  await expect(notification).toContainText(`${filename} · Изображение в буфере обмена`);
  const dimensions = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const image = items.find((item) => item.types.includes('image/png'));
    if (!image) return null;
    const bitmap = await createImageBitmap(await image.getType('image/png'));
    const size = [bitmap.width, bitmap.height];
    bitmap.close();
    return size;
  });
  assert.ok(dimensions?.every((value) => value > 1), 'В буфере обмена должна быть картинка PNG');
}

test('Скачанный PNG сохраняет цвет таблицы из предпросмотра Mermaid', { timeout: mermaidDownloadTimeout }, async (t) => {
  // Arrange: тема предпросмотра отличается от стандартной темы сервера.
  const { page } = await fixture(t, erDiagram, { mermaidTheme: 'neutral' });
  const diagram = page.locator('.vault-document:not([hidden]) .mermaid-block');
  const preview = diagram.locator('svg[aria-roledescription="er"]').first();
  await expect(preview).toContainText('SECTOR');
  const color = await preview.evaluate((svg) => {
    const shapes = Array.from(svg.querySelectorAll('rect, path, polygon'));
    const filled = shapes.map((shape) => {
      const { width, height } = shape.getBBox();
      return { area: width * height, fill: getComputedStyle(shape).fill };
    }).filter(({ fill, area }) => fill.startsWith('rgb(') && area > 0);
    return filled.sort((a, b) => b.area - a.area)[0]?.fill;
  });
  assert.ok(color, 'В предпросмотре должна быть заливка таблицы');
  await allowImageClipboard(page);
  await diagram.hover();

  // Act: скачиваем PNG через кнопку предпросмотра.
  const downloaded = page.waitForEvent('download');
  await diagram.getByRole('button', { name: 'Скачать PNG' }).click();
  const png = await downloaded;
  await expectImageClipboard(page, png.suggestedFilename());
  const base64 = await readFile(await png.path(), 'base64');

  // Assert: в скачанном файле таблица окрашена в цвет из предпросмотра.
  const matchingPixels = await page.evaluate(async ({ base64, color }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const expected = context.getImageData(0, 0, 1, 1).data;
    context.clearRect(0, 0, 1, 1);
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let matching = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (expected.every((component, offset) => pixels[index + offset] === component)) matching++;
    }
    return matching / (canvas.width * canvas.height);
  }, { base64, color });
  assert.ok(matchingPixels > 0.05, `Цвет ${color} занимает ${(matchingPixels * 100).toFixed(2)}% изображения`);
});

test('Основная кнопка Mermaid скачивает SVG и показывает имя файла', { timeout: mermaidDownloadTimeout }, async (t) => {
  // Arrange: открываем предпросмотр схемы.
  const { page } = await fixture(t, erDiagram);
  await allowImageClipboard(page);
  const diagram = page.locator('.vault-document:not([hidden]) .mermaid-block');
  await diagram.hover();

  // Act: скачиваем SVG.
  const downloaded = page.waitForEvent('download');
  const primary = diagram.getByRole('button', { name: 'Скачать SVG' });
  await expect(primary).toHaveText('SVG');
  await primary.click();
  const svg = await downloaded;

  // Assert: скачан SVG схемы, а уведомление показывает имя файла.
  assert.match(svg.suggestedFilename(), /\.svg$/);
  assert.match(await readFile(await svg.path(), 'utf8'), /<svg\b[\s\S]*SECTOR/);
  await expectImageClipboard(page, svg.suggestedFilename());
  await shot(page, 'mermaid-download-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'mermaid-download-mobile');
});

async function tabFixture(t) {
  const { page, suffix } = await fixture(t);
  const folder = `Fixtures/${suffix}`;
  const titles = ['Альфа', 'Бета', 'Гамма', 'Дельта'];
  await page.evaluate(() => localStorage.setItem('livenote_follow', '0'));
  for (const title of titles) {
    await api('/pages', 'POST', { title, path: `${folder}/${title}.md`, source: `# ${title}\n\nТекст заметки.\n` });
  }
  await page.reload();
  const tree = page.getByRole('navigation', { name: 'Файлы хранилища' });
  const open = (title) => tree.getByRole('button', { name: title, exact: true }).click();
  return { page, open, titles };
}

test('Главное меню находится справа в строке вкладок на обоих экранах', { timeout: tabsTimeout }, async t => {
  // Arrange: открыть документ в оболочке Vault.
  const { page } = await fixture(t);
  const row = page.locator('.vault-tabs-row');
  const menu = row.getByRole('button', { name: 'Меню LiveNote' });

  // Act: открыть главное меню, затем уменьшить ширину окна.
  await menu.click();
  await expect(page.getByRole('menuitem', { name: 'Настройки' })).toBeVisible();
  await page.keyboard.press('Escape');
  await shot(page, 'tabs-row-desktop');
  await page.setViewportSize({ width: 390, height: 844 });

  // Assert: отдельной верхней панели нет, оба действия видны в строке вкладок.
  await expect(page.getByRole('banner')).toHaveCount(0);
  await expect(menu).toBeInViewport();
  await expect(row.getByRole('button', { name: 'Открыть дерево заметок' })).toBeInViewport();
  const boxes = await row.evaluate((element) => {
    const rowRect = element.getBoundingClientRect();
    const menuRect = element.querySelector('[aria-label="Меню LiveNote"]').getBoundingClientRect();
    return { rowRight: rowRect.right, rowTop: rowRect.top, menuRight: menuRect.right };
  });
  assert.ok(boxes.rowRight - boxes.menuRight <= 12 && boxes.rowTop === 0);
  await shot(page, 'tabs-row-mobile');
});

test('Открытие файлов по очереди заменяет временную вкладку, а выбор закрепляет её', { timeout: tabsTimeout }, async t => {
  // Arrange: открыть папку с четырьмя заметками в чистом профиле.
  const { page, open, titles } = await tabFixture(t);
  const [first, second, kept, last] = titles;

  // Act: открыть три файла подряд, выбрать текущую вкладку, затем открыть четвёртый.
  await open(first);
  await open(second);
  await open(kept);
  await expect(tabTitles(page)).toHaveText([kept]);
  await documentTab(page, kept).click();
  await open(last);

  // Assert: выбранная вкладка и последний открытый файл остаются рядом.
  await expect(tabTitles(page)).toHaveText([kept, last]);
  await expect(documentTab(page, last)).toHaveAttribute('aria-selected', 'true');
});

test('История навигации переиспользует временную вкладку', { timeout: tabsTimeout }, async t => {
  // Arrange: открыть две заметки без выбора в строке вкладок.
  const { page, open, titles: [first, second] } = await tabFixture(t);
  await open(first);
  await open(second);

  // Act: перейти к предыдущему документу, а затем снова вперёд.
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(tabTitles(page)).toHaveText([first]);
  await page.getByRole('button', { name: 'Вперёд', exact: true }).click();

  // Assert: история вернула документ в единственную временную вкладку.
  await expect(tabTitles(page)).toHaveText([second]);
});

for (const { action, remaining } of [
  { action: 'Закрыть', remaining: [0, 2, 3] },
  { action: 'Закрыть остальные', remaining: [1] },
  { action: 'Закрыть все слева', remaining: [1, 2, 3] },
  { action: 'Закрыть все справа', remaining: [0, 1] }
]) {
  test(`Контекстное меню вкладки: ${action}`, { timeout: tabsTimeout }, async t => {
    // Arrange: открыть и выбрать по очереди четыре вкладки.
    const { page, open, titles } = await tabFixture(t);
    for (const title of titles) {
      await open(title);
      await documentTab(page, title).click();
    }
    await expect(tabTitles(page)).toHaveText(titles);

    // Act: вызвать действие над второй вкладкой.
    await documentTab(page, titles[1]).click({ button: 'right' });
    await page.getByRole('menuitem', { name: action, exact: true }).click();

    // Assert: нужные вкладки остались на прежних местах.
    await expect(tabTitles(page)).toHaveText(remaining.map(index => titles[index]));
  });
}

test('Контекстное меню вкладки копирует путь файла относительно хранилища', { timeout: tabsTimeout }, async t => {
  // Arrange: открыть документ и разрешить чтение буфера обмена в тестовом профиле.
  const { page, id, suffix } = await fixture(t);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  // Act: вызвать копирование пути из меню вкладки.
  await documentTab(page, suffix).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Скопировать путь' }).click();

  // Assert: буфер содержит путь вместе с папкой и расширением.
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(id);
});

async function insert(page, format) {
  await page.locator('.vault-document:not([hidden]) > .live-preview-editor > .lp-host > .cm-editor > .cm-scroller > .cm-content > .cm-line')
    .filter({ hasText: /\S/ }).last().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Вставить диаграмму' }).hover();
  const label = format === 'mermaid' ? 'Mermaid' : format === 'bpmn' ? 'BPMN' : format === 'drawio' ? 'draw.io' : format;
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

async function diagramDialog(page, format) {
  return page.locator(format === 'bpmn' ? '.bpmn-editor-dialog' : format === 'drawio' ? '.drawio-fullscreen' : '.diagram-fullscreen');
}

test('Document starts with content and inserts diagrams through the context menu', { timeout: 120_000 }, async (t) => {
  // Arrange: документ открывается сразу с содержимым.
  const { page, id } = await fixture(t, '# Архитектура сервиса\n\nОписание сервиса.\n');
  const article = page.locator(`.vault-document[data-page-id="${id}"]`);
  await expect(article.getByRole('textbox', { name: 'Имя файла' })).toHaveCount(0);
  await expect(article.getByRole('button', { name: 'Вставить диаграмму', exact: true })).toHaveCount(0);
  await expect(article.getByText('Сохранено', { exact: true })).toHaveCount(0);
  await expect(article.getByText('Markdown', { exact: true })).toHaveCount(0);
  const articleBox = await article.boundingBox();
  const editorBox = await article.locator('.cm-content').boundingBox();
  assert.ok(editorBox.y - articleBox.y < 40, 'Содержимое начинается у верхнего края документа');
  await shot(page, 'document-content-desktop');
  // Act: правое меню открывает создание схемы без верхней панели.
  await insert(page, 'mermaid');
  const dialog = await diagramDialog(page, 'mermaid');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  // Assert: на телефоне редактор тоже занимает освобождённое место.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(article.locator('.cm-content')).toBeVisible();
  assert.equal((await getDocument(id)).source, '# Архитектура сервиса\n\nОписание сервиса.\n');
  await shot(page, 'document-content-mobile');
});

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
  await page.locator('.vault-tree__page').filter({ hasText: suffix }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Переименовать', exact: true }).click();
  await page.getByRole('textbox', { name: 'Имя элемента' }).fill('Renamed');
  await page.getByRole('textbox', { name: 'Имя элемента' }).press('Enter');
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
  await page.route(documentRoute, async (route) => {
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
  await page.route(documentRoute, async (route) => {
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

for (const format of ['bpmn', 'drawio']) {
  test(`${format} показывает имя скачанного SVG поверх редактора`, { timeout: mermaidDownloadTimeout }, async (t) => {
    // Arrange: открываем редактор новой схемы.
    const { page } = await fixture(t);
    await allowImageClipboard(page);
    await insert(page, format);
    const dialog = await diagramDialog(page, format);
    await expect(dialog).toBeVisible();

    // Act: скачиваем SVG из редактора.
    const downloaded = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Скачать SVG', exact: true }).click();
    const svg = await downloaded;

    // Assert: уведомление поверх редактора содержит имя скачанного файла.
    assert.match(svg.suggestedFilename(), /\.svg$/);
    await expectImageClipboard(page, svg.suggestedFilename());
    await shot(page, `${format}-download-desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, `${format}-download-mobile`);
  });
}

test('All diagram formats cancel without writes, save atomically and embed existing files hidden from the tree', { timeout: 240_000 }, async (t) => {
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
  await expect(page.locator('.vault-tree__page').filter({ hasText: `${suffix} — Процесс` })).toHaveCount(0);
});

test('Removing and undoing one identical embed preserves the other embed and shared file', { timeout: 120_000 }, async (t) => {
  // Arrange: две одинаковые вставки используют один файл без тяжёлых редакторов рядом.
  const { page, id, suffix } = await fixture(t);
  const assetPath = `Fixtures/${suffix}/Flow.mmd`;
  const assetSource = 'flowchart LR\n A-->B';
  const embed = '![[./Flow.mmd]]';
  const source = `Перед.\n\n${embed}\n\n${embed}\n\nПосле.\n`;
  const withoutLastEmbed = `Перед.\n\n${embed}\n\n\n\nПосле.\n`;
  const document = await getDocument(id);
  await api(`/pages/${encodeURIComponent(id)}/document`, 'PUT', {
    ...tokens(document), source,
    assets: [{ path: assetPath, source: assetSource, expectedVersion: null }]
  });
  await page.reload();
  const lastEmbed = source.lastIndexOf(embed);
  const preview = page.locator(`.vault-document[data-page-id="${id}"] .lp-diagram[data-from="${lastEmbed}"]`);
  await expect(preview.locator('svg.flowchart')).toBeVisible();
  // Act: удаляем вторую вставку, отменяем удаление и удаляем через меню.
  await preview.getByRole('button', { name: 'Удалить диаграмму' }).click();
  await expect.poll(async () => (await getDocument(id)).source).toBe(withoutLastEmbed);
  assert.equal((await getDocument(assetPath)).source, assetSource);
  await page.locator(`.vault-document[data-page-id="${id}"] .cm-content`).focus();
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await getDocument(id)).source).toBe(source);
  await expect(preview.locator('svg.flowchart')).toBeVisible();
  await shot(page, 'diagram-undo');
  await preview.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Удалить диаграмму', exact: true }).click();
  // Assert: удалена только выбранная вставка, общий файл сохранён.
  await expect.poll(async () => (await getDocument(id)).source).toBe(withoutLastEmbed);
  assert.equal((await getDocument(assetPath)).source, assetSource);
});

test('Rejected diagram Save stays open and retries with the same valid base', { timeout: 120_000 }, async (t) => {
  const { page, id } = await fixture(t);
  await insert(page, 'mermaid');
  const dialog = await diagramDialog(page, 'mermaid');
  await expect(dialog).toBeVisible();
  let rejected = false;
  await page.route(documentRoute, async (route) => {
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

test('Diagram context actions do not follow the pointer onto document text', { timeout: 120_000 }, async (t) => {
  // Arrange: текст с двух сторон отделяет диаграмму от обычных строк.
  const source = 'Текст перед схемой.\n\n```mermaid\nflowchart LR\n A-->B\n```\n\nТекст после схемы.\n';
  const { page, id } = await fixture(t, source);
  const article = page.locator(`.vault-document[data-page-id="${id}"]`);
  const preview = article.locator('.lp-diagram');
  await expect(preview.locator('svg.flowchart')).toBeVisible();
  // Act: после меню схемы открываем меню на тексте и в пустом месте строки.
  await preview.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Удалить диаграмму', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Удалить диаграмму', exact: true }).press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Удалить диаграмму', exact: true })).toHaveCount(0);
  for (const text of ['Текст перед схемой.', 'Текст после схемы.']) {
    const line = article.locator('.cm-line').filter({ hasText: text });
    await line.click({ button: 'right', position: { x: 12, y: 8 } });
    // Assert: меню текста не содержит действий схемы и не меняет документ.
    await expect(page.getByRole('menuitem', { name: 'Вставить диаграмму', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Удалить диаграмму', exact: true })).toHaveCount(0);
    await shot(page, text.startsWith('Текст перед') ? 'text-menu-before' : 'text-menu-after');
    await page.getByRole('menuitem', { name: 'Копировать', exact: true }).press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Копировать', exact: true })).toHaveCount(0);
  }
  assert.equal((await getDocument(id)).source, source);
});

test('Diagram files are hidden from the tree and search while documents stay visible', { timeout: 120_000 }, async (t) => {
  // Arrange: отдельный файл схемы остаётся доступным для вставки.
  const { page, suffix } = await fixture(t);
  const assetPath = `Fixtures/${suffix}/Схемы/${suffix}-internal.mmd`;
  await api('/pages', 'POST', { title: `${suffix}-internal`, path: assetPath, source: 'flowchart LR\n A-->B' });
  await page.reload();
  // Assert: дерево показывает документы без внутренних файлов схем.
  await expect(page.locator('.vault-tree__page').filter({ hasText: suffix })).toHaveCount(1);
  // Act: ищем по общему имени заметки и схемы.
  await page.getByRole('searchbox').fill(suffix);
  // Assert: результат поиска не открывает внутреннюю схему как документ.
  await expect(page.locator('.vault-search-hit')).toHaveCount(1);
  await expect(page.locator('.vault-search-hit__path')).toHaveText(`Fixtures/${suffix}/${suffix}.md`);
  await shot(page, 'document-search');
});

test('Removing the last diagram embed deletes its file from the vault', { timeout: 120_000 }, async (t) => {
  // Arrange: файл схемы принадлежит одной вставке документа.
  const { page, id, suffix } = await fixture(t);
  const assetPath = `Fixtures/${suffix}/Схемы/Flow.mmd`;
  const document = await getDocument(id);
  await api(`/pages/${encodeURIComponent(id)}/document`, 'PUT', {
    ...tokens(document), source: `Текст перед схемой.\n\n![[./Схемы/Flow.mmd]]\n\nТекст после схемы.\n`,
    assets: [{ path: assetPath, source: 'flowchart LR\n A-->B', expectedVersion: null }]
  });
  await page.reload();
  const preview = page.locator(`.vault-document[data-page-id="${id}"] .lp-diagram`);
  await expect(preview.locator('svg.flowchart')).toBeVisible();
  // Act: удаляем вставку через её контекстное меню.
  await preview.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Удалить диаграмму', exact: true }).click();
  // Assert: сохранение удаляет вставку и файл, но оставляет окружающий текст.
  await expect.poll(async () => (await getDocument(id)).source).toBe('Текст перед схемой.\n\n\n\nТекст после схемы.\n');
  assert.equal((await api('/vault')).files.some((file) => file.path === assetPath), false);
  await api(`/pages/${encodeURIComponent(assetPath)}/document`, 'GET', undefined, 404);
  await expect(preview).toHaveCount(0);
  await shot(page, 'diagram-deleted');
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
  const movedId = `Fixtures/${suffix}/Empty/Inside.md`;
  await expect(page.locator(`.vault-document[data-page-id="${movedId}"]`)).toBeVisible();
  assert.equal((await getDocument(movedId)).path, movedId);
  await page.getByRole('button', { name: 'Empty', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Переместить', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Переместить' });
  await dialog.getByRole('textbox', { name: 'Путь' }).fill(`Fixtures/${suffix}/Moved`);
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator(`.vault-document[data-page-id="Fixtures/${suffix}/Moved/Inside.md"]`)).toBeVisible();
  assert.equal((await getDocument(`Fixtures/${suffix}/Moved/Inside.md`)).path, `Fixtures/${suffix}/Moved/Inside.md`);
  await page.getByRole('button', { name: 'Moved', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить папку?' });
  await shot(page, 'delete-folder-confirmation-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'delete-folder-confirmation-mobile');
  await confirmation.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await api(`/pages/${encodeURIComponent(`Fixtures/${suffix}/Moved/Inside.md`)}/document`, 'GET', undefined, 404);
});

test('Deleting a document from the tree removes it permanently through the public API', { timeout: 120_000 }, async (t) => {
  // Arrange: отдельный документ можно удалить через меню дерева.
  const { page, id, suffix } = await fixture(t);
  await page.locator('.vault-tree__page').filter({ hasText: suffix }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить файл?' });
  await expect(confirmation).toBeVisible();
  await shot(page, 'delete-document-confirmation');
  // Act: подтверждаем окончательное удаление.
  await confirmation.getByRole('button', { name: 'Удалить', exact: true }).click();
  // Assert: документ исчез из дерева и недоступен через API.
  await expect(confirmation).toHaveCount(0);
  await expect(page.locator('.vault-tree__page').filter({ hasText: suffix })).toHaveCount(0);
  await api(`/pages/${encodeURIComponent(id)}/document`, 'GET', undefined, 404);
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
  const { vaultName } = await api('/vault');
  await moved.dragTo(page.getByRole('button', { name: vaultName, exact: true }));
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
  const file = page.locator('.vault-tree__page').filter({ hasText: suffix });
  await file.click();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(documentRoute, async (route) => {
    if (route.request().method() === 'PUT') await gate;
    await route.continue();
  });
  try {
    const editor = page.locator(`.vault-document[data-page-id="${id}"] .cm-content`);
    await editor.click();
    await page.keyboard.press('Meta+End');
    const started = page.waitForRequest(
      request => request.method() === 'PUT' && documentRoute.test(new URL(request.url()).pathname),
      { timeout: 10_000 }
    );
    await page.keyboard.type('\n\nLOCAL DRAFT');
    await started;
    await file.dragTo(target);
    await expect(page.getByRole('alert')).toContainText('Сохраните черновики и закройте диалоги перед перемещением.');
    await expect(editor).toContainText('LOCAL DRAFT');
    assert.equal((await getDocument(id)).path, id);
  } finally { release(); }
  await expect.poll(async () => (await getDocument(id)).source).toContain('LOCAL DRAFT');
});

test('Mobile tree, persistent Vim and dark theme remain usable without horizontal overflow', { timeout: 120_000 }, async (t) => {
  const { page } = await fixture(t);
  await page.getByRole('button', { name: 'Меню LiveNote' }).click();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Настройки' });
  const vimSwitch = settings.getByRole('switch', { name: 'Vim mode' });
  await settings.getByText('Vim mode', { exact: true }).click();
  await expect(vimSwitch).toBeChecked();
  await vimSwitch.press('Space');
  await expect(vimSwitch).not.toBeChecked();
  await vimSwitch.press('Space');
  await expect(vimSwitch).toBeChecked();
  await shot(page, 'settings-switches-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'settings-switches-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await page.getByRole('button', { name: 'Меню LiveNote' }).click();
  await page.getByRole('menuitem', { name: 'Тёмная тема', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'mobile-dark');
  await page.getByRole('button', { name: 'Открыть дерево заметок' }).click();
  await expect(page.getByRole('dialog', { name: 'Дерево заметок' })).toBeVisible();
  await shot(page, 'mobile-tree-dark');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Following external edits scrolls to the changed text without moving the cursor', { timeout: 120_000 }, async (t) => {
  // Arrange: изменение находится ниже видимой области длинного документа.
  const source = Array.from({ length: 120 }, (_, index) => `Строка документа ${index}.\n\n`).join('');
  const { page, id } = await fixture(t, source);
  const article = page.locator(`.vault-document[data-page-id="${id}"]`);
  const editor = article.locator('.cm-content').first();
  await editor.click({ position: { x: 12, y: 12 } });
  await page.keyboard.press('Meta+Home');
  const before = await getDocument(id);
  // Act: другой клиент дописывает текст в конце документа.
  await api(`/pages/${encodeURIComponent(id)}/document`, 'PUT', { ...tokens(before), source: `${source}Изменение агента.\n` });
  // Assert: редактор показывает изменение, сохраняя позицию курсора в начале.
  await expect(article.locator('.cm-line').filter({ hasText: 'Изменение агента.' })).toBeInViewport();
  await page.keyboard.type('КУРСОР ');
  await expect.poll(async () => (await getDocument(id)).source).toBe(`КУРСОР ${source}Изменение агента.\n`);
  await shot(page, 'follow-external-edit');
});

test('Following external creation opens the new document', { timeout: 120_000 }, async (t) => {
  // Arrange: пользователь просматривает другую заметку.
  const { page, suffix } = await fixture(t);
  const createdPath = `Fixtures/${suffix}/Created.md`;
  // Act: другой клиент создаёт документ.
  await api('/pages', 'POST', { title: 'Created', path: createdPath, source: '# Новая заметка агента\n' });
  // Assert: включённое следование открывает новую заметку.
  await expect(page.locator(`.vault-document[data-page-id="${createdPath}"]`)).toBeVisible();
  await expect(page.locator('.vault-document:not([hidden]) .cm-content')).toContainText('Новая заметка агента');
});

test('Following an external edit reopens a closed document', { timeout: 120_000 }, async (t) => {
  // Arrange: закрываем документ агента и возвращаемся к исходной заметке.
  const { page, id, suffix } = await fixture(t);
  const remotePath = `Fixtures/${suffix}/Remote.md`;
  await api('/pages', 'POST', { title: 'Remote', path: remotePath, source: '# Документ агента\n' });
  await expect(page.locator(`.vault-document[data-page-id="${remotePath}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть Remote', exact: true }).click();
  await expect(page.locator(`.vault-document[data-page-id="${id}"]`)).toBeVisible();
  const before = await getDocument(remotePath);
  // Act: другой клиент обновляет закрытый документ.
  await api(`/pages/${encodeURIComponent(remotePath)}/document`, 'PUT', { ...tokens(before), source: '# Документ агента\n\nНовая версия.\n' });
  // Assert: следование открывает документ с актуальным содержимым.
  await expect(page.locator(`.vault-document[data-page-id="${remotePath}"]`)).toBeVisible();
  await expect(page.locator('.vault-document:not([hidden]) .cm-content')).toContainText('Новая версия.');
});

test('Following does not switch away from an unsaved draft', { timeout: 120_000 }, async (t) => {
  // Arrange: сохранение локального текста ожидает ответа сервера.
  const { page, id, suffix } = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  await page.route(documentRoute, async route => {
    if (route.request().method() === 'PUT') { startedResolve(); await gate; }
    await route.continue();
  });
  const article = page.locator(`.vault-document[data-page-id="${id}"]`);
  await article.locator('.cm-content').first().click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.type('\nЛокальный черновик.');
  await started;
  try {
    // Act: агент создаёт другую заметку во время сохранения черновика.
    await api('/pages', 'POST', { title: 'Remote', path: `Fixtures/${suffix}/Remote.md`, source: '# Документ агента\n' });
    await expect(page.locator('.vault-tree__page').filter({ hasText: 'Remote' })).toBeVisible();
    // Assert: текущая заметка и её текст остаются на экране.
    await expect(article).toBeVisible();
    await expect(article.locator('.cm-content').first()).toContainText('Локальный черновик.');
  } finally { release(); }
  await expect.poll(async () => (await getDocument(id)).source).toContain('Локальный черновик.');
});

test('Disabled following keeps the current tab and scroll while content still updates', { timeout: 120_000 }, async (t) => {
  // Arrange: отключаем следование клавиатурой и проверяем сохранённую настройку.
  const source = Array.from({ length: 100 }, (_, index) => `Исходная строка ${index}.\n\n`).join('');
  const { page, id, suffix } = await fixture(t, source);
  await page.getByRole('button', { name: 'Меню LiveNote' }).click();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Настройки' });
  const follow = settings.getByRole('switch', { name: 'Следовать за изменениями' });
  await expect(follow).toBeChecked();
  await follow.press('Space');
  await expect(follow).not.toBeChecked();
  await settings.getByRole('button', { name: 'Готово' }).click();
  await page.reload();
  const article = page.locator(`.vault-document[data-page-id="${id}"]`);
  await expect(article).toBeVisible();
  const scroller = article.locator('.cm-scroller').first();
  const before = await getDocument(id);
  const updated = `${source}Обновление без следования.\n`;
  const loaded = page.waitForResponse(response => response.request().method() === 'GET'
    && response.url().endsWith(`/pages/${encodeURIComponent(id)}/document`));
  // Act: обновляем открытую заметку и создаём другую.
  await api(`/pages/${encodeURIComponent(id)}/document`, 'PUT', { ...tokens(before), source: updated });
  await loaded;
  await api('/pages', 'POST', { title: 'Other', path: `Fixtures/${suffix}/Other.md`, source: '# Другая заметка\n' });
  // Assert: документ обновился без смены вкладки и прокрутки.
  await expect(article).toBeVisible();
  assert.equal(await scroller.evaluate(element => element.scrollTop), 0);
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(article.locator('.cm-line').filter({ hasText: 'Обновление без следования.' })).toBeVisible();
});
