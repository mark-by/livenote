import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect, webkit } from 'playwright/test';

const base = process.env.LIVENOTE_TEST_URL;
if (!base) throw new Error('Задайте LIVENOTE_TEST_URL отдельного vault-сервера.');
const screenshots = process.env.LIVENOTE_SCREENSHOT_DIR;
let browser;
let sequence = 0;

before(async () => {
  const webkitExecutable = process.env.LIVENOTE_TEST_WEBKIT_EXECUTABLE;
  browser = webkitExecutable
    ? await webkit.launch({ executablePath: webkitExecutable, headless: true })
    : await chromium.launch({ channel: 'chrome', headless: true });
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

async function fixture(t, source = '# Заголовок\n\nТекст заметки с **акцентом** и #тег.\n\n- первый пункт\n- второй пункт\n\n> Цитата.\n', { mermaidTheme, additionalFile, macTitlebar } = {}) {
  const suffix = `shell-${Date.now()}-${sequence++}`;
  const id = `Fixtures/${suffix}/${suffix}.md`;
  await api('/pages', 'POST', { title: suffix, path: id, source });
  if (additionalFile) {
    const file = { title: additionalFile, path: `Fixtures/${suffix}/${additionalFile}.md`, source: '# Заметка' };
    await api('/pages', 'POST', file);
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (mermaidTheme) {
    await context.addInitScript((theme) => localStorage.setItem('livenote_mermaid_theme', theme), mermaidTheme);
  }
  if (macTitlebar) {
    await context.addInitScript(() => { window.__LIVENOTE_MACOS_TITLEBAR__ = true; });
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
  await navigation.locator('.vault-tree__page').getByText(suffix, { exact: true }).click();
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

test('Таблица сохраняет правки ячейки и структуры в заметке хранилища', { timeout: tabsTimeout }, async t => {
  // Arrange: открыть таблицу в приложении с отдельным хранилищем.
  const source = '# Результаты\n\n| Имя | Число |\n| --- | ---: |\n| Первый | 1 |\n';
  const { page, id } = await fixture(t, source);
  const grid = page.getByRole('grid', { name: 'Таблица Markdown' });
  const input = grid.getByRole('textbox', { name: 'Содержимое ячейки' });
  await grid.getByRole('gridcell', { name: '1' }).click();
  await input.fill('42');
  await shot(page, 'table-cell-edit');

  // Act: добавить строку из меню открытого поля, не подтверждая правку отдельно.
  await input.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Действия с таблицей' });
  await expect(menu).toBeVisible();
  await shot(page, 'table-context-menu');
  await menu.getByRole('menuitem', { name: 'Добавить строку' }).press('ArrowRight');
  await shot(page, 'table-row-submenu');
  await page.getByRole('menuitem', { name: 'После' }).click();

  // Assert: сервер вернул Markdown с обеими правками.
  const expected = source.replace('| Первый | 1 |', '| Первый | 42 |\n|  |  |');
  await expect.poll(async () => (await getDocument(id)).source).toBe(expected);
  await expect(grid.getByRole('row')).toHaveCount(3);
});

test('Большая таблица показывает одну страницу и сохраняет правку в нужной строке', { timeout: tabsTimeout }, async t => {
  // Arrange: разместить целевую ячейку на второй странице таблицы.
  const width = 10;
  const row = index => `| ${Array.from({ length: width }, (_, column) => `Данные-${index}-${column}`).join(' | ')} |`;
  const editedRow = 33;
  const source = `# Результаты\n\n| ${Array.from({ length: width }, (_, index) => `Колонка ${index}`).join(' | ')} |\n${'| --- '.repeat(width)}|\n${Array.from({ length: 40 }, (_, index) => row(index + 1)).join('\n')}\n`;
  const { page, id } = await fixture(t, source);
  const grid = page.getByRole('grid', { name: 'Таблица Markdown' });
  const target = grid.getByRole('gridcell', { name: `Данные-${editedRow}-1`, exact: true });
  const firstPageCell = grid.getByRole('gridcell', { name: 'Данные-1-1', exact: true });
  await expect(firstPageCell).toBeVisible();
  await expect(target).toHaveCount(0);

  // Act: открыть следующую страницу и сохранить правку в её первой строке.
  await page.getByRole('button', { name: 'Следующая страница таблицы' }).click();
  await expect(firstPageCell).toHaveCount(0);
  await target.click();
  const input = grid.getByRole('textbox', { name: 'Содержимое ячейки' });
  await input.fill('Новое значение');
  await input.press('Enter');

  // Assert: сохранённый Markdown отличается только целевой ячейкой.
  const expected = source.replace(`Данные-${editedRow}-1`, 'Новое значение');
  await expect.poll(async () => (await getDocument(id)).source).toBe(expected);
  await expect(grid.getByRole('gridcell', { name: 'Новое значение', exact: true })).toBeVisible();
});

test('Удалённая таблица освобождает DOM без закрытия заметки', { timeout: tabsTimeout }, async t => {
  if (browser.browserType().name() !== 'chromium') return t.skip('Принудительная сборка мусора требует CDP.');
  // Arrange: сохранить слабую ссылку на DOM виджета, который помещается в кэш.
  const shortSource = '# Результаты\n\nБез таблицы.\n';
  const source = '# Результаты\n\n| Имя | Число |\n| --- | ---: |\n| Первый | 1 |\n';
  const { page, id } = await fixture(t, source);
  await page.locator('.lp-table').evaluate(element => { window.deletedTableWidget = new WeakRef(element); });
  const cdp = await page.context().newCDPSession(page);
  const before = await getDocument(id);

  // Act: заменить документ извне, оставив вкладку открытой.
  await api(`/pages/${encodeURIComponent(id)}/document`, 'PUT', { ...tokens(before), source: shortSource });

  // Assert: редактор показывает новый текст и больше не удерживает старый виджет.
  await expect(page.locator('.vault-document:not([hidden]) .cm-content')).toContainText('Без таблицы.');
  await expect.poll(async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return page.evaluate(() => window.deletedTableWidget.deref() === undefined);
  }).toBe(true);
});

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

test('Верхняя строка macOS оставляет место для системных кнопок', { timeout: tabsTimeout }, async t => {
  // Arrange: открыть заметку в окне с верхней строкой macOS.
  const { page } = await fixture(t, undefined, { macTitlebar: true });
  const row = page.locator('.vault-tabs-row');
  const tab = row.getByRole('tab', { selected: true });
  const history = row.getByRole('button', { name: 'Назад', exact: true });
  const dragRegion = row.locator('[data-tauri-drag-region]');

  // Act: выбрать открытую вкладку.
  await tab.click();

  // Assert: стрелки находятся за системными кнопками, область перетаскивания не закрывает вкладку.
  const bounds = await row.boundingBox();
  const arrow = await history.boundingBox();
  const tabBounds = await tab.boundingBox();
  const dragBounds = await dragRegion.boundingBox();
  assert.ok(bounds && arrow && tabBounds && dragBounds);
  const systemButtonsRight = 74;
  assert.ok(arrow.x >= bounds.x + systemButtonsRight);
  assert.ok(dragBounds.x >= tabBounds.x + tabBounds.width);
  await shot(page, 'tabs-row-macos');
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

const visibleDocuments = (page) => page.locator('article.vault-document:visible');
const documentArticle = (page, id) => page.locator(`article.vault-document[data-page-id="${id}"]`);

async function splitFixture(t) {
  const title = 'Вторая заметка';
  const { page, id, suffix } = await fixture(t, 'Текст первой заметки.\n', { additionalFile: title });
  const secondId = `Fixtures/${suffix}/${title}.md`;
  const tree = page.getByRole('navigation', { name: 'Файлы хранилища' });
  const openSecond = () => tree.getByRole('button', { name: title, exact: true }).click();
  await documentTab(page, suffix).click();
  return { page, id, suffix, title, secondId, openSecond };
}

async function splitTab(page, title, action) {
  await documentTab(page, title).click({ button: 'right' });
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test('Разделение вправо оставляет документ слева и открывает файл из дерева справа', { timeout: tabsTimeout }, async t => {
  // Arrange: открыт только первый документ. Второй файл доступен в дереве.
  const { page, id, suffix, title, secondId, openSecond } = await splitFixture(t);
  const first = documentArticle(page, id);
  const full = await first.boundingBox();
  assert.ok(full, 'Первый документ виден до разделения');

  // Act: разделяем текущую вкладку и открываем второй файл без выбора панели.
  await splitTab(page, suffix, 'Split Right');
  await expect(visibleDocuments(page)).toHaveCount(1);
  await expect.poll(async () => (await first.boundingBox())?.width).toBeLessThan(full.width);
  await openSecond();

  // Assert: оба документа видны. Второй документ расположен справа от первого.
  const second = documentArticle(page, secondId);
  await expect(visibleDocuments(page)).toHaveCount(2);
  const [left, right] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  assert.ok(left && right, 'Оба документа видны после открытия файла');
  expect(left.x).toBeCloseTo(full.x, 0);
  expect(right.y).toBeCloseTo(left.y, 0);
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  await expect(page.locator('.vault-tabs-row')).toHaveCount(1);
  await expect(tabTitles(page)).toHaveText([suffix, title]);
});

test('Разделение вниз показывает скрытую вкладку под текущим документом', { timeout: tabsTimeout }, async t => {
  // Arrange: закрепляем первую вкладку и открываем вторую заметку вместо первой.
  const { page, id, suffix, secondId, openSecond } = await splitFixture(t);
  await openSecond();
  const first = documentArticle(page, id);
  const second = documentArticle(page, secondId);
  await expect(second).toBeVisible();
  await expect(first).toBeHidden();
  await expect(documentTab(page, suffix)).toBeVisible();

  // Act: разделяем вниз через меню скрытой вкладки.
  await splitTab(page, suffix, 'Split Down');

  // Assert: текущий документ остаётся сверху, первый открывается под ним.
  await expect(visibleDocuments(page)).toHaveCount(2);
  const [top, bottom] = await Promise.all([second.boundingBox(), first.boundingBox()]);
  assert.ok(top && bottom, 'Оба документа видны после разделения');
  expect(bottom.x).toBeCloseTo(top.x, 0);
  expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
});

test('Редактор автоматически сохраняет изменения из обеих панелей', { timeout: tabsTimeout }, async t => {
  // Arrange: открываем второй файл и разделяем его вкладку. Скрытая вкладка заполняет правую панель.
  const { page, id, title, secondId, openSecond } = await splitFixture(t);
  await openSecond();
  await expect(documentArticle(page, secondId)).toBeVisible();
  await splitTab(page, title, 'Split Right');
  await expect(visibleDocuments(page)).toHaveCount(2);
  const firstText = 'Правка первой заметки.';
  const secondText = 'Правка второй заметки.';

  // Act: меняем текст по очереди в обоих редакторах без команды сохранения.
  for (const [path, text] of [[id, firstText], [secondId, secondText]]) {
    await documentArticle(page, path).locator('.cm-line').first().click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(text);
  }

  // Assert: сервер вернул свой новый текст для каждого файла.
  await expect.poll(async () => {
    const documents = await Promise.all([getDocument(id), getDocument(secondId)]);
    return documents.map(({ source }) => source.trim());
  }).toEqual([firstText, secondText]);
});

test('Изменение размеров вложенных панелей сохраняет DOM редакторов', { timeout: tabsTimeout }, async t => {
  // Arrange: обе заметки открыты, правая панель разделена по высоте.
  const { page, id, suffix, title, secondId, openSecond } = await splitFixture(t);
  await splitTab(page, suffix, 'Split Right');
  await openSecond();
  await splitTab(page, title, 'Split Down');
  const area = page.locator('.vault-editor-area');
  const vertical = area.getByRole('separator', { name: 'Ширина панелей редактора' });
  const horizontal = area.getByRole('separator', { name: 'Высота панелей редактора' });
  const editors = area.locator('.cm-editor:visible');
  await expect(editors).toHaveCount(2);
  const originalEditors = await editors.elementHandles();
  const areaBox = await area.boundingBox();
  const verticalBox = await vertical.boundingBox();
  const horizontalBox = await horizontal.boundingBox();
  assert.ok(areaBox && verticalBox && horizontalBox);

  // Act: увеличиваем левую панель и уменьшаем верхнюю правую. Затем нажимаем стрелку.
  const x = verticalBox.x + verticalBox.width / 2;
  const y = horizontalBox.y + horizontalBox.height / 2;
  const dx = Math.round(areaBox.width / 5);
  const dy = Math.round(areaBox.height / 5);
  await page.mouse.move(x, areaBox.y + areaBox.height / 4);
  await page.mouse.down();
  await page.mouse.move(x + dx, areaBox.y + areaBox.height / 4);
  await page.mouse.up();
  const nested = await horizontal.boundingBox();
  assert.ok(nested);
  await page.mouse.move(nested.x + nested.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(nested.x + nested.width / 2, y - dy);
  await page.mouse.up();
  await horizontal.press('ArrowDown');

  // Assert: разделитель не выходит за правую ветвь, обе заметки остаются в тех же DOM-узлах.
  const frames = area.locator('.vault-editor-frame');
  const left = await frames.filter({ has: documentArticle(page, id) }).boundingBox();
  const right = await frames.filter({ has: documentArticle(page, secondId) }).boundingBox();
  const divider = await horizontal.boundingBox();
  assert.ok(left && right && divider);
  expect(Math.abs(left.width - areaBox.width * 0.7)).toBeLessThan(2);
  expect(Math.abs(right.height - areaBox.height * 0.35)).toBeLessThan(2);
  expect(Math.abs(divider.x - right.x)).toBeLessThan(2);
  expect(Math.abs(divider.width - right.width)).toBeLessThan(2);
  expect(await editors.evaluateAll((current, original) =>
    current.every((editor, index) => editor === original[index]), originalEditors)).toBe(true);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
});

test('Закрытие вкладки в разделённом редакторе оставляет другой документ видимым', { timeout: tabsTimeout }, async t => {
  // Arrange: открываем второй файл в новой правой панели.
  const { page, id, suffix, title, secondId, openSecond } = await splitFixture(t);
  await splitTab(page, suffix, 'Split Right');
  await openSecond();
  await expect(visibleDocuments(page)).toHaveCount(2);

  // Act: закрываем вкладку второго документа.
  await documentTab(page, title).getByRole('button', { name: `Закрыть ${title}`, exact: true }).click();

  // Assert: закрытая вкладка исчезла, первая заметка осталась открыта.
  await expect(tabTitles(page)).toHaveText([suffix]);
  await expect(documentArticle(page, secondId)).toBeHidden();
  await expect(documentArticle(page, id).locator('.cm-content')).toBeVisible();
});

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

test('Меню файла в дереве копирует путь без открытой вкладки', { timeout: tabsTimeout }, async t => {
  // Arrange: создаём второй файл до запуска интерфейса и заполняем буфер.
  const title = 'Заметка без вкладки';
  const { page, suffix } = await fixture(t, undefined, { additionalFile: title });
  const path = `Fixtures/${suffix}/${title}.md`;
  await allowImageClipboard(page);
  await expect(page.locator('[data-vault-tab]').filter({ hasText: title })).toHaveCount(0);

  // Act: копируем путь через контекстное меню строки файла.
  const file = page.locator('.vault-sidebar').getByRole('button', { name: title, exact: true });
  await file.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Контекстное меню файла' });
  const copy = menu.getByRole('menuitem', { name: 'Скопировать путь', exact: true });
  await expect(copy).toBeVisible();
  await shot(page, 'tree-copy-path-menu');
  await copy.click();

  // Assert: в буфере путь от корня хранилища, включая расширение.
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(path);
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

const delayedWriteCases = [
  { outcome: 'shows the external document', screenshot: 'external' },
  { outcome: 'preserves newer typing and reports a conflict', newerEdit: true, screenshot: 'draft' },
  { outcome: 'shows the external document after closing the saved diagram', diagram: true, screenshot: 'diagram' }
];
for (const { outcome, newerEdit, diagram, screenshot } of delayedWriteCases) {
  test(`Delayed accepted PUT after external SSE ${outcome}`, { timeout: tabsTimeout }, async (t) => {
    // Arrange: наблюдаем события, которые SharedWorker доставляет редактору.
    const { page, id } = await fixture(t);
    await page.addInitScript(() => {
      window.vaultTestEvents = [];
      window.SharedWorker = class extends window.SharedWorker {
        constructor(...args) {
          super(...args);
          this.port.addEventListener('message', ({ data }) => {
            if (data.name === 'open') window.vaultTestEvents.push(data);
            if (data.name === 'page.updated') window.vaultTestEvents.push(JSON.parse(data.data));
          });
        }
      };
    });
    await page.reload();
    const editor = page.locator(`.vault-document[data-page-id="${id}"] .cm-content`);
    await expect(editor).toBeVisible();
    await page.waitForFunction(() => window.vaultTestEvents.some(event => event.name === 'open'));
    let accept, fail, release;
    const accepted = new Promise((resolve, reject) => { accept = resolve; fail = reject; });
    const gate = new Promise(resolve => { release = resolve; });
    let writes = 0;
    await page.route(documentRoute, async (route) => {
      if (route.request().method() !== 'PUT' || ++writes !== 1) return route.continue();
      try {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        accept((await response.json()).document);
        await gate;
        await route.fulfill({ response });
      } catch (error) {
        fail(error);
        throw error;
      }
    });

    // Act: сервер принимает PUT. Независимый клиент меняет файл до доставки ответа.
    const externalSource = '# Внешняя версия\n\nREMOTE NEXT.\n';
    const vaultRoot = process.env.LIVENOTE_TEST_VAULT_ROOT;
    let dialog;
    try {
      if (diagram) {
        await insert(page, 'mermaid');
        dialog = await diagramDialog(page, 'mermaid');
        await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
      } else {
        await editor.click();
        await page.keyboard.press('Meta+End');
        await page.keyboard.type('\n\nLOCAL ACCEPTED.');
      }
      const saved = await accepted;
      assert.match(saved.source, diagram ? /```mermaid/ : /LOCAL ACCEPTED\./);
      t.diagnostic(`PUT 200 на сервере, ответ удержан: ${saved.version}`);
      if (newerEdit) await page.keyboard.type(' NEWER TYPING.');
      await page.waitForFunction(({ id, revision }) => window.vaultTestEvents
        .some(event => event.pageId === id && event.revision === revision), { id, revision: saved.page.revision });
      let externalRevision;
      if (vaultRoot) await writeFile(`${vaultRoot}/${id}`, externalSource);
      else {
        const { document } = await api(`/pages/${encodeURIComponent(id)}/document`, 'PUT', { ...tokens(saved), source: externalSource });
        externalRevision = document.page.revision;
      }
      const delivered = await page.waitForFunction(({ id, savedRevision, externalRevision }) => window.vaultTestEvents
        .find(event => event.pageId === id && event.event === 'page.updated' && event.revision !== savedRevision
          && (externalRevision === undefined ? event.origin === 'external' : event.revision === externalRevision)),
      { id, savedRevision: saved.page.revision, externalRevision });
      t.diagnostic(`Браузер получил SSE до ответа PUT: ${JSON.stringify(await delivered.jsonValue())}`);
      assert.equal((await getDocument(id)).source, externalSource);
    } finally {
      release();
      t.diagnostic('Доставляем удержанный ответ PUT редактору');
    }

    // Assert: результат зависит только от наличия более новой локальной правки.
    try {
      if (dialog) await expect(dialog).toHaveCount(0);
      if (newerEdit) {
        await expect(page.getByRole('button', { name: 'Скачать черновик' })).toBeVisible();
        await expect(editor).toContainText('LOCAL ACCEPTED. NEWER TYPING.');
      } else {
        await expect(editor).toContainText('REMOTE NEXT.');
        await expect(page.getByRole('button', { name: 'Скачать черновик' })).toHaveCount(0);
        assert.equal(writes, 1);
      }
      assert.equal((await getDocument(id)).source, externalSource);
    } finally {
      t.diagnostic(`После ответа PUT, текст редактора: ${await editor.textContent()}`);
      await shot(page, `document-write-race-${screenshot}`);
    }
  });
}

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

test('Перемещение предпросмотра draw.io не перезагружает его iframe', { timeout: tabsTimeout }, async t => {
  // Arrange: дождаться предпросмотра встроенной схемы в Markdown-редакторе.
  const { page, id, suffix } = await fixture(t);
  const before = await getDocument(id);
  const source = 'Строка перед схемой.\n\n![[./Flow.drawio|Схема]]\n';
  const xml = '<mxfile><diagram name="Схема"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="shape" value="Пример" vertex="1" parent="1"><mxGeometry width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
  await api(`/pages/${encodeURIComponent(id)}/document`, 'PUT', {
    ...tokens(before), source, assets: [{ path: `Fixtures/${suffix}/Flow.drawio`, source: xml, expectedVersion: null }]
  });
  await page.reload();
  const widget = page.locator('.lp-diagram').filter({ has: page.locator('.drawio-block') });
  const image = widget.locator('.drawio-preview__image');
  await expect(image).toBeVisible({ timeout: 45_000 });

  // Act: переместить виджет как при перестройке DOM редактора.
  const sameDocument = await widget.evaluate(element => {
    const parent = element.parentElement;
    const frame = document.querySelector('iframe.drawio-frame-host');
    const frameDocument = frame?.contentDocument;
    if (!parent || !frameDocument || element === parent.firstChild) throw Error('Виджет нечего перемещать.');
    parent.insertBefore(element, parent.firstChild);
    return frame.contentDocument === frameDocument;
  });

  // Assert: предпросмотр сохраняет загруженный документ и не показывает предупреждение.
  assert.equal(sameDocument, true, 'Перемещение виджета заменило документ iframe.');
  await expect(image).toBeVisible();
  await expect(widget.getByRole('alert')).toHaveCount(0);
});

test('draw.io вставляется после BPMN при щелчке у нижнего края схемы', { timeout: tabsTimeout }, async t => {
  // Arrange: поместить BPMN в конец заметки, как в сценарии с дефектом.
  const { page, id, suffix } = await fixture(t);
  const before = await getDocument(id);
  const source = '# Начало заметки\n\n![[./Process.bpmn|Схема]]\n\n';
  const bpmnSource = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
    id="Definitions" targetNamespace="urn:livenote:test">
    <process id="Process"><startEvent id="Start"/></process>
    <bpmndi:BPMNDiagram id="Diagram"><bpmndi:BPMNPlane id="Plane" bpmnElement="Process">
      <bpmndi:BPMNShape id="Shape" bpmnElement="Start"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
  </definitions>`;
  await api(`/pages/${encodeURIComponent(id)}/document`, 'PUT', {
    ...tokens(before), source, assets: [{ path: `Fixtures/${suffix}/Process.bpmn`, source: bpmnSource, expectedVersion: null }]
  });
  await page.reload();
  const bpmn = page.locator('.lp-diagram').filter({ has: page.locator('.bpmn-view-host .djs-container') });
  await expect(bpmn).toBeVisible();
  const box = await bpmn.boundingBox();
  assert.ok(box);

  // Act: открыть меню в поле редактора сбоку от нижнего края, вне самой схемы.
  await page.mouse.click(box.x - 6, box.y + box.height - 2, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Вставить диаграмму' }).hover();
  await page.getByRole('menuitem', { name: 'draw.io', exact: true }).click();
  const drawioEditor = await diagramDialog(page, 'drawio');
  await drawioEditor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(drawioEditor).toHaveCount(0, { timeout: 30_000 });

  // Assert: обе схемы сохранились в порядке вставки.
  const saved = await getDocument(id);
  assert.deepEqual(saved.page.blocks.filter(block => block.type !== 'markdown').map(block => block.type), ['bpmn', 'drawio']);
  await expect(page.locator('.lp-diagram').first().locator('.bpmn-block')).toBeVisible();
  await expect(page.locator('.lp-diagram').last().locator('.drawio-block')).toBeVisible();
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

async function diagramTitleFixture(t, makeSource) {
  const { page, id, suffix } = await fixture(t);
  const fileName = 'Flow.mmd';
  const assetPath = `Fixtures/${suffix}/${fileName}`;
  const assetSource = 'flowchart LR\n A-->B';
  const source = makeSource(fileName);
  const document = await getDocument(id);
  await api(`/pages/${encodeURIComponent(id)}/document`, 'PUT', {
    ...tokens(document), source,
    assets: [{ path: assetPath, source: assetSource, expectedVersion: null }]
  });
  await page.reload();
  return { page, id, source, assetPath };
}

test('Щелчок по названию схемы позволяет изменить только выбранную вставку', { timeout: tabsTimeout }, async t => {
  // Arrange: две вставки ссылаются на один файл схемы.
  const beforeTitle = 'Схема';
  const newTitle = 'Размещение товара';
  const { page, id, source, assetPath } = await diagramTitleFixture(t, fileName =>
    `![[./${fileName}|${beforeTitle}]]\n\n![[./${fileName}|Копия схемы]]\n`);
  const beforeAsset = await getDocument(assetPath);
  const title = page.locator('.lp-diagram').getByRole('button', { name: beforeTitle, exact: true });

  // Act: открыть поле щелчком и сохранить новое название.
  await title.click({ timeout: 5000 });
  const input = page.getByRole('textbox', { name: 'Название схемы', exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(beforeTitle);
  await shot(page, 'diagram-title-edit');
  await input.fill(newTitle);
  await input.press('Enter');

  // Assert: изменилось название одной вставки, а не общий файл.
  const expected = source.replace(beforeTitle, newTitle);
  await expect.poll(async () => (await getDocument(id)).source).toBe(expected);
  await expect(page.locator('.lp-diagram').getByRole('button', { name: newTitle, exact: true })).toBeVisible();
  const afterAsset = await getDocument(assetPath);
  assert.equal(afterAsset.version, beforeAsset.version);
  assert.equal(afterAsset.source, beforeAsset.source);
});

test('Escape отменяет редактирование названия схемы', { timeout: tabsTimeout }, async t => {
  // Arrange: название показывает подпись обычной Markdown-вставки.
  const beforeTitle = 'Схема';
  const { page, id, source } = await diagramTitleFixture(t, fileName => `![${beforeTitle}](./${fileName})\n`);
  const title = page.locator('.lp-diagram').getByRole('button', { name: beforeTitle, exact: true });
  await title.click({ timeout: 5000 });
  const input = page.getByRole('textbox', { name: 'Название схемы', exact: true });
  await input.fill('Черновик названия');

  // Act: отменить ввод названия.
  await input.press('Escape');

  // Assert: поле закрылось, прежнее название осталось в заметке.
  await expect(title).toBeFocused();
  assert.equal((await getDocument(id)).source, source);
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

test('Diagram-only folders and diagram files are hidden while documents stay visible', { timeout: 120_000 }, async (t) => {
  // Arrange: отдельный файл схемы остаётся доступным для вставки.
  const { page, suffix } = await fixture(t);
  const assetPath = `Fixtures/${suffix}/Схемы/${suffix}-internal.mmd`;
  await api('/pages', 'POST', { title: `${suffix}-internal`, path: assetPath, source: 'flowchart LR\n A-->B' });
  // Act: загружаем дерево после добавления схемы.
  await page.reload();
  // Assert: дерево показывает заметку и скрывает папку со схемой.
  const navigation = page.getByRole('navigation', { name: 'Файлы хранилища' });
  const notes = navigation.locator('.vault-tree__page').filter({ hasText: suffix });
  await expect(notes).toHaveCount(1);
  await expect(notes).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Схемы', exact: true })).toHaveCount(0);
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

test('Разделитель меняет ширину панели без выделения текста', { timeout: tabsTimeout }, async (t) => {
  // Arrange: открываем длинную заметку и ставим курсор в текст.
  const source = Array.from({ length: 40 }, (_, index) => `Строка ${index + 1} со словами для выделения мышью.`).join('\n\n');
  const { page, id } = await fixture(t, source);
  const editor = page.locator(`.vault-document[data-page-id="${id}"] .cm-content`);
  await editor.click({ position: { x: 25, y: 25 } });
  const divider = page.getByRole('separator', { name: 'Ширина дерева заметок' });
  const box = await divider.boundingBox();
  assert.ok(box);
  const startX = box.x + box.width - 1;
  const startY = box.y + 260;
  const distance = 110;

  // Act: ведём разделитель по диагонали через область текста.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + distance, startY + 470, { steps: 18 });
  await page.mouse.up();

  // Assert: панель стала шире, выделения в документе нет.
  await expect(divider).toHaveAttribute('aria-valuenow', String(box.x + distance));
  assert.equal(await page.evaluate(() => getSelection()?.toString()), '');
});

test('Ширина дерева после перетаскивания сохраняется при повторном открытии', { timeout: tabsTimeout }, async (t) => {
  // Arrange: открываем заметку и определяем исходную ширину панели.
  const { page } = await fixture(t);
  const sidebar = page.locator('.vault-sidebar');
  const divider = page.getByRole('separator', { name: 'Ширина дерева заметок' });
  const start = await divider.boundingBox();
  assert.ok(start);
  const initialWidth = await sidebar.evaluate(element => element.clientWidth);
  const distance = 96;
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;

  // Act: перетаскиваем разделитель вправо и открываем окно заново.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => sidebar.evaluate(element => element.clientWidth)).toBe(initialWidth + distance);
  const context = page.context();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(base);

  // Assert: ширина в новом окне совпадает с выбранной.
  await expect.poll(() => reopened.locator('.vault-sidebar').evaluate(element => element.clientWidth))
    .toBe(initialWidth + distance);
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

test('Сброс на файл в раскрытой вложенной папке переносит заметку в эту папку', { timeout: tabsTimeout }, async (t) => {
  // Arrange: раскрываем вложенную папку с заметкой, на которую можно сбросить файл.
  const { page, id, suffix } = await fixture(t);
  const destination = `Fixtures/${suffix}/Destination`;
  const existingTitle = 'Existing';
  const existing = { title: existingTitle, path: `${destination}/${existingTitle}.md`, source: '# Заметка в папке' };
  await api('/pages', 'POST', existing);
  await page.reload();
  const navigation = page.getByRole('navigation', { name: 'Файлы хранилища' });
  await navigation.getByRole('button', { name: 'Destination', exact: true }).click();
  const target = navigation.getByRole('button', { name: existingTitle, exact: true });
  const dragged = navigation.locator('.vault-tree__file').filter({
    has: page.getByRole('button', { name: suffix, exact: true })
  });
  await expect(target).toBeVisible();
  await dragged.click({ trial: true });
  await target.click({ trial: true });

  // Act: сбрасываем заметку на строку файла, а не на заголовок папки.
  await dragged.dragTo(target);

  // Assert: сервер переместил заметку во вложенную папку, а не в родительскую.
  const movedPath = `${destination}/${suffix}.md`;
  await expect.poll(async () => {
    const { files } = await api('/vault');
    return files.map(entry => entry.path).filter(path => path === id || path === movedPath);
  }, { timeout: 3000 }).toEqual([movedPath]);
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
  const mode = page.getByRole('group', { name: 'Состояние активного редактора' }).getByRole('status');
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

test('Компактный статус показывает связанные заметки активной области', { timeout: tabsTimeout }, async t => {
  // Arrange: первая заметка ссылается на вторую, которую открываем в отдельной области.
  const title = 'Заметка справа';
  const source = `[Ссылка](${encodeURIComponent(`${title}.md`)})`;
  const { page, id, suffix } = await fixture(t, source, { additionalFile: title });
  const secondId = `Fixtures/${suffix}/${title}.md`;
  await splitTab(page, suffix, 'Split Right');
  await page.locator('.vault-sidebar').getByRole('button', { name: title, exact: true }).click();
  const right = documentArticle(page, secondId);
  await expect(right).toBeVisible();
  const status = page.getByRole('group', { name: 'Состояние активного редактора' });
  const scroller = right.locator('.cm-scroller');
  const [editorBox, workspaceBox, statusBox] = await Promise.all([
    scroller.boundingBox(), page.getByRole('main').boundingBox(), status.boundingBox()
  ]);
  assert.ok(editorBox && workspaceBox && statusBox);
  expect(editorBox.y + editorBox.height).toBeCloseTo(workspaceBox.y + workspaceBox.height, 0);
  expect(statusBox.y).toBeGreaterThan(editorBox.y);
  await expect(status.getByRole('button', { name: 'Связанные заметки: 1' })).toBeVisible();

  // Act: открываем связанную заметку через кнопку справа внизу.
  await status.getByRole('button', { name: 'Связанные заметки: 1' }).click();
  const links = page.getByRole('dialog', { name: 'Связанные заметки' });
  await links.getByRole('button', { name: new RegExp(suffix) }).click();

  // Assert: фокус и счётчик переключились на первую заметку, обе области видны.
  await expect(documentArticle(page, id)).toBeVisible();
  await expect(right).toBeVisible();
  await expect(documentTab(page, suffix)).toHaveAttribute('aria-selected', 'true');
  await expect(status.getByRole('button', { name: 'Связанные заметки: 0' })).toBeVisible();
});

test('Полоса прокрутки заметки доходит до правого края редактора', { timeout: tabsTimeout }, async t => {
  // Arrange: готовим заметку, которая не помещается по высоте.
  const source = Array.from({ length: 90 }, (_, index) => `Строка ${index + 1}`).join('\n');

  // Act: открываем заметку.
  const { page, id } = await fixture(t, source);
  const scroller = documentArticle(page, id).locator('.cm-scroller');

  // Assert: область прокрутки доходит до края панели.
  const gap = await scroller.evaluate(element =>
    element.closest('.vault-editor-frame__body').getBoundingClientRect().right - element.getBoundingClientRect().right
  );
  expect(gap).toBeCloseTo(0, 0);
});

test('Верхний отступ прокручивается вместе со страницей, а путь остаётся сверху', { timeout: tabsTimeout }, async t => {
  // Arrange: открываем заметку с содержимым длиннее области прокрутки.
  const source = Array.from({ length: 90 }, (_, index) => `Строка страницы ${index + 1}`).join('\n');
  const { page, id } = await fixture(t, source);
  const article = documentArticle(page, id);
  const breadcrumbs = article.getByRole('navigation', { name: 'Путь к заметке' });
  const scroller = article.locator('.cm-scroller');
  const first = article.locator('.cm-line').filter({ hasText: /^Строка страницы 1$/ });
  const [pathTop, viewport, initial] = await Promise.all([
    breadcrumbs.boundingBox(), scroller.boundingBox(), first.boundingBox()
  ]);
  assert.ok(pathTop && viewport && initial);
  const gap = initial.y - viewport.y;
  expect(gap).toBeGreaterThan(0);
  expect(viewport.y).toBeCloseTo(pathTop.y + pathTop.height, 0);

  // Act: прокручиваем заметку ровно на высоту начального отступа.
  await scroller.evaluate((element, offset) => { element.scrollTop = offset; }, gap);

  // Assert: первая строка дошла до края области прокрутки, шапка не сместилась.
  await expect.poll(async () => (await first.boundingBox())?.y).toBeCloseTo(viewport.y, 0);
  expect((await breadcrumbs.boundingBox())?.y).toBe(pathTop.y);
});

test('Сегмент пути раскрывает папку в дереве и оставляет заметку открытой', { timeout: tabsTimeout }, async t => {
  // Arrange: открываем документ во вложенной папке и сворачиваем её родителя.
  const { page, id, suffix } = await fixture(t);
  const tree = page.getByRole('navigation', { name: 'Файлы хранилища' });
  await tree.getByRole('button', { name: 'Fixtures', exact: true }).click();
  await expect(tree.getByRole('heading', { name: suffix, exact: true })).toBeHidden();
  const article = documentArticle(page, id);
  const breadcrumbs = article.getByRole('navigation', { name: 'Путь к заметке' });

  // Act: выбираем вложенную папку по её сегменту пути.
  const folderLink = breadcrumbs.getByRole('link', { name: suffix, exact: true })
    .and(page.locator(':not([aria-current])'));
  await folderLink.click();

  // Assert: нужная папка снова видна и выбрана, файл остался в редакторе.
  const folder = tree.locator('.vault-tree__folder-row').filter({
    has: page.getByRole('heading', { name: suffix, exact: true })
  });
  await expect(folder).toHaveAttribute('data-selected', 'true');
  await expect(article).toBeVisible();
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
