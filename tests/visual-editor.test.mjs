import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from 'playwright/test';

const base = process.env.LIVENOTE_TEST_URL;
if (!base) throw new Error('Задайте LIVENOTE_TEST_URL отдельного тестового сервера.');
const testTimeout = 45_000;
const originalSource = 'flowchart LR\n  Request["Заявка"] -->|Проверка| Result["Результат"]';
const originalClassSource = `classDiagram
direction BT
%% Описание схемы сохраняется при редактировании.
class cells {
 bigint cell_type_id
 boolean closed_for_placing
}
class racks {
 bigint rack_id
}
cells "1" --> "*" racks : находится
style cells fill:#d5ebdb
`;
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

async function fixture(t, source = originalSource) {
  // Arrange: каждый сценарий получает отдельную страницу в тестовой базе.
  const { page: created } = await api('/pages', { title: `Редактор ${crypto.randomUUID()}` });
  await api(`/pages/${created.id}/blocks`, {
    blockId: 'diagram', type: 'mermaid', source, expectedRevision: created.revision
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  t.after(async () => {
    await context.close();
    const { page: current } = await (await fetch(`${base}/api/pages/${created.id}`)).json();
    await api(`/pages/${created.id}`, { expectedRevision: current.revision }, 'DELETE');
  });
  await page.goto(base);
  await page.getByRole('button', { name: created.title, exact: true }).click();
  await page.locator('.mermaid-block svg[id^="livenote-"]').waitFor();
  await page.locator('.mermaid-block').hover();
  await page.getByRole('button', { name: 'Во весь экран', exact: true }).click();
  await page.locator('.diagram-fullscreen__svg > svg').waitFor();
  return { page, id: created.id, dialog: page.getByRole('dialog').first() };
}

async function stored(id) {
  const { page } = await (await fetch(`${base}/api/pages/${id}`)).json();
  return page;
}

/** Trigger HeroUI — button; его accessible name включает label и текущее значение. */
async function selectOption(page, label, value) {
  await page.getByRole('button', { name: label }).click();
  await page.getByRole('option').filter({ hasText: value }).last().click();
}

test('Полноэкранное открытие показывает схему без редактора и записи', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t);
  // Act: открытие уже выполнено через кнопку блока.
  // Assert: действия редактирования отсутствуют, ревизия и исходник прежние.
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeEnabled();
  await expect(page.getByRole('complementary', { name: 'Редактор узлов и связей' })).toHaveCount(0);
  assert.equal((await stored(id)).revision, 2);
  assert.equal((await stored(id)).blocks[0].source, originalSource);
});

test('Выбор узла на схеме позволяет сохранить новую подпись', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.locator('.diagram-fullscreen .node').filter({ hasText: 'Заявка' }).click();
  // Act: ввод подписи и сохранение через полноэкранный редактор.
  await page.getByLabel('Подпись узла', { exact: true }).fill('Проверенная заявка');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  // Assert: сервер хранит изменение; оно остаётся после перезагрузки.
  assert.match((await stored(id)).blocks[0].source, /Проверенная заявка/);
  await page.reload();
  await expect(page.locator('.mermaid-block .node').filter({ hasText: 'Проверенная заявка' })).toHaveCount(1);
});

test('Шесть вкладок LiveNote не блокируют сохранение диаграммы', { timeout: testTimeout }, async (t) => {
  // Arrange: каждая вкладка подписывается на обновления того же HTTP-сервера.
  const { page, id, dialog } = await fixture(t, originalClassSource);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await selectOption(page, 'Выбранный класс', 'cells');
  await page.getByLabel('Подпись класса', { exact: true }).fill('Ячейки склада');
  const current = await stored(id);
  const additionalTabs = [];
  for (let index = 0; index < 5; index++) {
    const tab = await page.context().newPage();
    additionalTabs.push(tab);
    await tab.goto(base);
    await expect(tab.getByRole('complementary').getByRole('button', { name: current.title, exact: true })).toBeVisible();
  }
  // Act: запись должна пройти, пока остальные вкладки продолжают получать события.
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  // Assert: ответ приходит без закрытия вкладок, сервер хранит новую подпись.
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  assert.match((await stored(id)).blocks[0].source, /Ячейки склада/);
  for (const tab of additionalTabs) {
    await expect(tab.locator('.mermaid-block .node').filter({ hasText: 'Ячейки склада' })).toHaveCount(1);
  }
});

test('Закрытие первой вкладки сохраняет обновления в другой вкладке', { timeout: testTimeout }, async (t) => {
  // Arrange: обе вкладки получают события одной страницы.
  const { page, id } = await fixture(t);
  const remainingTab = await page.context().newPage();
  await remainingTab.goto(base);
  await remainingTab.locator('.mermaid-block svg[id^="livenote-"]').waitFor();
  // Act: после закрытия первой вкладки сервер меняет подпись узла.
  await page.close();
  const current = await stored(id);
  const source = originalSource.replace('Заявка', 'Обновлённая заявка');
  await api(`/pages/${id}/blocks/diagram`, { source, expectedRevision: current.revision }, 'PUT');
  // Assert: оставшаяся вкладка показывает изменение без перезагрузки.
  await expect(remainingTab.locator('.mermaid-block .node').filter({ hasText: 'Обновлённая заявка' })).toHaveCount(1);
});

test('Добавление узла и связи сохраняет новую структуру', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  // Act: новый узел соединяют с существующим и сохраняют.
  await page.getByRole('button', { name: 'Добавить узел', exact: true }).click();
  await page.getByLabel('Подпись узла', { exact: true }).fill('Архив');
  await selectOption(page, 'От узла', 'Result');
  await selectOption(page, 'К узлу', 'node_1');
  await page.getByLabel('Подпись новой связи', { exact: true }).fill('Завершено');
  await page.getByRole('button', { name: 'Добавить связь', exact: true }).click();
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  // Assert: сохранённая схема содержит узел и направленную связь с подписью.
  const result = await stored(id);
  assert.match(result.blocks[0].source, /Архив/);
  assert.match(result.blocks[0].source, /Result\s*-->/);
  assert.match(result.blocks[0].source, /Завершено/);
  assert.equal(result.revision, 3);
});

test('Отмена подтверждённых изменений не записывает черновик', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await selectOption(page, 'Выбранный узел', 'Request');
  await page.getByLabel('Подпись узла', { exact: true }).fill('Черновик');
  // Act: пользователь отменяет черновик с подтверждением.
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  // Assert: исходник и ревизия не изменились.
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  assert.equal((await stored(id)).blocks[0].source, originalSource);
  assert.equal((await stored(id)).revision, 2);
});

test('Конфликт ревизии сохраняет серверную версию и оставляет черновик открытым', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await selectOption(page, 'Выбранный узел', 'Request');
  await page.getByLabel('Подпись узла', { exact: true }).fill('Мой черновик');
  const concurrentSource = 'flowchart LR\n  Other["Изменение агента"]';
  await api(`/pages/${id}/blocks/diagram`, { source: concurrentSource, expectedRevision: 2 }, 'PUT');
  // Act: сохранение с исходной ревизией после записи другим клиентом.
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  // Assert: серверную схему не перезаписывают, черновик доступен для копирования.
  await expect(dialog.getByRole('alert')).toContainText('Страница изменилась');
  await expect(page.getByLabel('Подпись узла', { exact: true })).toHaveValue('Мой черновик');
  assert.equal((await stored(id)).blocks[0].source, concurrentSource);
});

test('Sequence diagram доступна для просмотра и сохранения исходника', { timeout: testTimeout }, async (t) => {
  const source = 'sequenceDiagram\n  Alice->>Bob: Привет';
  const { page, id, dialog } = await fixture(t, source);
  await expect(page.locator('.diagram-fullscreen__svg > svg')).toBeVisible();
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  const input = dialog.getByLabel('Исходник Mermaid', { exact: true });
  await expect(input).toHaveValue(source);
  const changed = 'sequenceDiagram\n  Alice->>Bob: Новый исходник';
  await input.fill(changed);
  await expect(page.locator('.diagram-fullscreen__svg')).toContainText('Новый исходник');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  const result = await stored(id);
  assert.equal(result.blocks[0].source, changed);
  assert.equal(result.revision, 3);
});

test('Удаление узла удаляет его связи и оставляет другой узел', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await selectOption(page, 'Выбранный узел', 'Request');
  // Act: пользователь удаляет исходный узел и сохраняет диаграмму.
  await page.getByRole('button', { name: 'Удалить узел и его связи', exact: true }).click();
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  // Assert: на сервере остаётся второй узел без связи с удалённым.
  const result = await stored(id);
  assert.doesNotMatch(result.blocks[0].source, /Request|-->/);
  assert.match(result.blocks[0].source, /Result\["Результат"\]/);
});

test('Выбор линии на схеме позволяет сохранить подпись связи', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  // Act: пользователь выбирает линию и меняет подпись.
  const point = await page.locator('.diagram-fullscreen .flowchart-link').evaluate((path) => {
    const local = path.getPointAtLength(path.getTotalLength() / 5);
    const screen = local.matrixTransform(path.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
  await page.getByLabel('Подпись связи', { exact: true }).fill('Готово');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  // Assert: новая подпись записана вместо исходной.
  const result = await stored(id);
  assert.match(result.blocks[0].source, /Готово/);
  assert.doesNotMatch(result.blocks[0].source, /Проверка/);
});

test('Tab после включения редактора оставляет фокус внутри диаграммы', { timeout: testTimeout }, async (t) => {
  const { page, dialog } = await fixture(t);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  // Act: кнопка включения исчезла, пользователь продолжает навигацию клавишей Tab.
  await page.keyboard.press('Tab');
  // Assert: фокус переходит к первому доступному действию модального окна.
  await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
});

test('classDiagram открывается в режиме просмотра с доступным редактором', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t, originalClassSource);
  // Act: открытие диаграммы не включает редактирование.
  // Assert: пользователь может включить редактор, исходник не меняется.
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeEnabled();
  await expect(page.getByRole('complementary', { name: 'Редактор классов и отношений' })).toHaveCount(0);
  assert.equal((await stored(id)).blocks[0].source, originalClassSource);
});

test('Выбор класса на схеме позволяет сохранить его подпись и поля', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t, originalClassSource);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.locator('.diagram-fullscreen .node').filter({ hasText: 'cell_type_id' }).click();
  // Act: пользователь меняет подпись и вводит поля, включая завершающий перенос.
  await page.getByLabel('Подпись класса', { exact: true }).fill('Ячейка');
  await page.getByLabel('Поля и методы', { exact: true }).fill('bigint cell_type_id\n+open()\n');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  // Assert: поля и псевдоним сохранены, комментарий, стиль и кардинальности остаются.
  const result = await stored(id);
  assert.match(result.blocks[0].source, /cells\["Ячейка"\]/);
  assert.match(result.blocks[0].source, /\+open\(\)/);
  assert.doesNotMatch(result.blocks[0].source, /boolean closed_for_placing/);
  assert.ok(result.blocks[0].source.includes('cells "1" --> "*" racks : находится'));
  assert.ok(result.blocks[0].source.includes('style cells fill:#d5ebdb'));
  await page.reload();
  await expect(page.locator('.mermaid-block .node').filter({ hasText: 'Ячейка' })).toContainText('open()');
});

test('Добавляет класс и отношение с выбранным типом', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t, originalClassSource);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  // Act: новый класс добавляют в схему и связывают с существующим.
  await page.getByRole('button', { name: 'Добавить класс', exact: true }).click();
  await page.getByLabel('Подпись класса', { exact: true }).fill('Сектор');
  await selectOption(page, 'От класса', 'racks');
  await selectOption(page, 'К классу', 'node_1');
  await selectOption(page, 'Тип нового отношения', 'o--');
  await page.getByLabel('Подпись нового отношения', { exact: true }).fill('включает');
  await page.getByRole('button', { name: 'Добавить отношение', exact: true }).click();
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  // Assert: сервер хранит новый класс и агрегацию.
  const result = await stored(id);
  assert.match(result.blocks[0].source, /node_1\["Сектор"\]/);
  assert.match(result.blocks[0].source, /racks o-- node_1 : включает/);
});

test('Меняет тип отношения и подпись, сохраняя кардинальности', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t, originalClassSource);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await selectOption(page, 'Выбранное отношение', 'edge-0');
  // Act: пользователь меняет оператор отношения и его подпись.
  await selectOption(page, 'Тип отношения', '*--');
  await page.getByLabel('Подпись отношения', { exact: true }).fill('содержит');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  // Assert: кардинальности не теряются при замене оператора и подписи.
  assert.ok((await stored(id)).blocks[0].source.includes('cells "1" *-- "*" racks : содержит'));
});

test('Удаляет класс вместе с отношениями, сохраняя другой класс', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t, originalClassSource);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await selectOption(page, 'Выбранный класс', 'cells');
  // Act: удаление класса должно убрать все его отношения и стили.
  await page.getByRole('button', { name: 'Удалить класс и его отношения', exact: true }).click();
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  // Assert: другой класс и его поле сохранены.
  const result = await stored(id);
  assert.doesNotMatch(result.blocks[0].source, /cells|-->/);
  assert.match(result.blocks[0].source, /class racks/);
  assert.match(result.blocks[0].source, /bigint rack_id/);
});

test('Отмена полей classDiagram возвращает исходную схему', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t, originalClassSource);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await selectOption(page, 'Выбранный класс', 'cells');
  await page.getByLabel('Поля и методы', { exact: true }).fill('text draft');
  // Act: пользователь отменяет черновик.
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  // Assert: исходные поля остаются на сервере.
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  assert.equal((await stored(id)).blocks[0].source, originalClassSource);
});

test('Некорректное поле класса блокирует сохранение и показывает ошибку', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t, originalClassSource);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await selectOption(page, 'Выбранный класс', 'cells');
  // Act: пользователь вводит строку, которая меняет структуру исходника.
  await page.getByLabel('Поля и методы', { exact: true }).fill('int value }');
  await page.getByLabel('Подпись класса', { exact: true }).fill('Ячейка');
  // Assert: исходник не записывается, пользователь видит причину отказа.
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Поля и методы', { exact: true })).toHaveValue('int value }');
  assert.equal((await stored(id)).blocks[0].source, originalClassSource);
});

test('Очищает все поля класса, сохраняя сам класс и его отношения', { timeout: testTimeout }, async (t) => {
  const { page, id, dialog } = await fixture(t, originalClassSource);
  await dialog.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await selectOption(page, 'Выбранный класс', 'cells');
  // Act: пользователь удаляет весь текст из поля элементов.
  await page.getByLabel('Поля и методы', { exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Редактировать', exact: true })).toBeVisible();
  // Assert: класс остаётся в диаграмме, отношение не удаляется.
  const result = await stored(id);
  assert.match(result.blocks[0].source, /class cells/);
  assert.doesNotMatch(result.blocks[0].source, /cell_type_id|closed_for_placing/);
  assert.ok(result.blocks[0].source.includes('cells "1" --> "*" racks : находится'));
});

test('Текст при увеличении 10× сохраняет резкость нативного SVG', { timeout: testTimeout }, async (t) => {
  // Arrange: широкая схема сначала уменьшена до окна, как исходная схема пользователя.
  const classNames = Array.from({ length: 18 }, (_, index) => `Table_${index}`);
  const source = 'classDiagram\ndirection BT\n' + classNames
    .map((name) => `class ${name} {\n bigint warehouse_identifier\n int capacity\n}`)
    .join('\n');
  const { page } = await fixture(t, source);
  const targetClass = page.locator('.diagram-fullscreen .node[id*="-classId-Table_0-"]');
  const label = targetClass.locator('.nodeLabel').filter({ hasText: 'bigint warehouse_identifier' });
  const initial = await label.boundingBox();
  assert.ok(initial);
  const area = await page.locator('.diagram-fullscreen__body').boundingBox();
  assert.ok(area);
  const center = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  await page.screenshot();
  await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
  await page.mouse.down();
  await page.mouse.move(center.x, center.y);
  await page.mouse.up();
  // Act: штатный обработчик колеса увеличивает диаграмму до предельного масштаба.
  await page.evaluate(async (point) => {
    const canvas = document.querySelector('.diagram-fullscreen__canvas');
    for (let step = 0; step < 32; step++) {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -1, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true
      }));
      await new Promise(requestAnimationFrame);
    }
  }, center);
  const enlarged = await label.boundingBox();
  assert.ok(enlarged);
  assert.ok(Math.abs(enlarged.width / initial.width - 10) < 0.01, 'Диаграмма должна увеличиться в 10 раз.');
  const clip = {
    x: Math.floor(enlarged.x), y: Math.floor(enlarged.y),
    width: Math.ceil(enlarged.width), height: Math.ceil(enlarged.height)
  };
  const actual = await page.screenshot();
  await page.evaluate(async () => {
    const svg = document.querySelector('.diagram-fullscreen__svg svg');
    const rect = svg.getBoundingClientRect();
    const reference = svg.cloneNode(true);
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:#f7f8fa;overflow:hidden';
    Object.assign(reference.style, {
      position: 'absolute', left: `${rect.x}px`, top: `${rect.y}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, maxWidth: 'none'
    });
    overlay.append(reference);
    document.body.append(overlay);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const reference = await page.screenshot();
  const sharpness = await page.evaluate(async ({ images, region }) => {
    const values = [];
    for (const encoded of images) {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = region.width;
      canvas.height = region.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, -region.x, -region.y);
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      const gray = (x, y) => {
        const offset = (y * width + x) * 4;
        return (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
      };
      let energy = 0;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const edge = 4 * gray(x, y) - gray(x - 1, y) - gray(x + 1, y) - gray(x, y - 1) - gray(x, y + 1);
          energy += edge * edge;
        }
      }
      values.push(energy / ((width - 2) * (height - 2)));
    }
    return values;
  }, { images: [actual.toString('base64'), reference.toString('base64')], region: clip });
  // Assert: контуры букв близки по резкости к прямому рендеру SVG в целевом размере.
  const ratio = sharpness[0] / sharpness[1];
  t.diagnostic(`Резкость относительно нативного SVG: ${(ratio * 100).toFixed(1)}%.`);
  assert.ok(Number.isFinite(ratio) && ratio >= 0.75,
    `Резкость текста составляет ${(ratio * 100).toFixed(1)}% от нативного SVG.`);
});
