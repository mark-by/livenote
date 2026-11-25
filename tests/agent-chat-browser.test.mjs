import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { expect } from 'playwright/test';
import { assertionTimeout, sessionOne, startAgentChatFixture, turnOne } from './agent-chat-fixture.mjs';
import { registerComposerChecks } from './helpers/agent-chat-composer-checks.mjs';

const timeout = 60_000;
const loginToken = 'login-token-fixture';
let fixture, state, loginFixture;

before(async () => { fixture = await startAgentChatFixture(); });
beforeEach(() => { state = fixture.reset(); });
after(async () => { await Promise.all([fixture?.close(), loginFixture?.close()]); });

const open = (t) => fixture.open(t);
const shot = (page, name) => fixture.shot(page, name);
registerComposerChecks(() => fixture, timeout);

test('Чат агента не запрашивает данные до входа и загружает их после', { timeout }, async t => {
  // Arrange: реальный VaultApp за формой токена; панель агента не смонтирована.
  loginFixture = await startAgentChatFixture({ token: loginToken, realApp: true });
  const loginState = loginFixture.reset();
  const { page, dialog } = await loginFixture.openLogin(t);
  // Приложение смонтировалось: bootstrap уже сделал запросы /api без токена (401).
  await expect.poll(() => loginState.apiRequests.length).toBeGreaterThan(0);
  // Assert: за формой входа ноль запросов к агентским маршрутам.
  assert.equal(loginState.requests.length, 0);
  await expect(page.getByRole('complementary', { name: 'Чат агента' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Чат агента', exact: true })).toHaveCount(0);
  await loginFixture.shot(page, 'agent-login-gate');
  // Act: войти штатной формой.
  await dialog.getByLabel('Токен').fill(loginToken);
  await dialog.getByRole('button', { name: 'Открыть' }).click();
  // Assert: после входа чат скрыт, но его можно открыть даже без активной заметки.
  const panel = page.getByRole('complementary', { name: 'Чат агента' });
  const toggle = page.getByRole('button', { name: 'Чат агента', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(panel).toBeHidden();
  await page.getByRole('navigation', { name: 'Файлы хранилища' }).getByRole('button', { name: 'note', exact: true }).click();
  const status = page.getByRole('group', { name: 'Состояние активного редактора' });
  await expect(status.getByRole('button', { name: /Связанные заметки/ })).toBeVisible();
  await expect(status.getByRole('button', { name: 'Чат агента', exact: true })).toBeVisible();
  await loginFixture.shot(page, 'agent-status-light-closed');

  await toggle.press('Space');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toBeVisible({ timeout: assertionTimeout });
  await expect(panel.getByText('Старый ответ')).toBeVisible();
  await expect(panel.getByRole('button', { name: /История разговоров/ })).toContainText('Первый разговор');
  await page.reload();
  await expect(panel).toBeVisible();

  const menuButton = page.getByRole('button', { name: 'Меню LiveNote' });
  await menuButton.click();
  const menu = page.getByRole('menu', { name: 'Меню LiveNote' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Открыть папку', 'Тёмная тема', 'Настройки']);
  await loginFixture.shot(page, 'agent-status-light-menu');
  await menu.getByRole('menuitem', { name: 'Тёмная тема' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await loginFixture.shot(page, 'agent-status-dark-open');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toBeInViewport();
  await expect(panel).toBeInViewport();
  await loginFixture.shot(page, 'agent-status-mobile-dark-open');
  await toggle.click();
  await expect(panel).toBeHidden();
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(panel).toBeHidden();
  await loginFixture.shot(page, 'agent-status-mobile-dark-closed');
});

test('Горячие клавиши видны в настройках и переключают панель агента вне диалогов', { timeout }, async t => {
  const app = await startAgentChatFixture({ token: loginToken, realApp: true });
  t.after(() => app.close());
  app.reset();
  const { page, dialog: login } = await app.openLogin(t, 'MacIntel');
  await login.getByLabel('Токен').fill(loginToken);
  await login.getByRole('button', { name: 'Открыть' }).click();
  const toggle = page.getByRole('button', { name: 'Чат агента', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Meta+,');
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  const search = dialog.getByRole('searchbox', { name: 'Поиск настроек' });
  await search.fill('hotkeys');
  await dialog.getByRole('button', { name: /Назад по истории файлов/ }).click();
  await expect(dialog.getByRole('heading', { name: 'Горячие клавиши' })).toBeFocused();
  for (const [action, keys] of [
    ['Назад по истории файлов', '⌘['],
    ['Вперёд по истории файлов', '⌘]'],
    ['Открыть или закрыть панель агента', '⌘P'],
    ['Открыть настройки', '⌘,']
  ]) {
    await expect(dialog.getByRole('listitem').filter({ hasText: action }).locator('kbd')).toHaveText(keys);
  }
  await app.shot(page, 'hotkeys-desktop-light');
  await page.keyboard.press('Meta+p');
  await dialog.getByRole('button', { name: 'Готово' }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await page.keyboard.press('Meta+p');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('complementary', { name: 'Чат агента' });
  await expect(panel).toBeVisible();
  await panel.getByRole('textbox', { name: 'Сообщение агенту' }).press('Meta+p');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(panel).toBeHidden();
});

test('Горячие клавиши можно переназначить, сохранить и сбросить', { timeout }, async t => {
  const app = await startAgentChatFixture({ token: loginToken, realApp: true });
  t.after(() => app.close());
  app.reset();
  const { page, dialog: login } = await app.openLogin(t, 'MacIntel');
  await login.getByLabel('Токен').fill(loginToken);
  await login.getByRole('button', { name: 'Открыть' }).click();
  const toggle = page.getByRole('button', { name: 'Чат агента', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  const selectHotkeys = () => dialog.getByRole('option', { name: 'Горячие клавиши' }).click();

  await page.keyboard.press('Meta+,');
  await selectHotkeys();
  const agentBinding = dialog.getByRole('button', { name: /Изменить сочетание: Открыть или закрыть панель агента/ });
  await agentBinding.focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByText(/Нажмите новое сочетание/)).toBeVisible();
  await app.shot(page, 'hotkeys-recording');
  await page.keyboard.press('Meta+[');
  await expect(dialog.getByRole('alert')).toContainText('Назад по истории файлов');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(agentBinding).toContainText('⌘P');

  await agentBinding.click();
  await page.keyboard.press('Meta+Shift+Y');
  await expect(agentBinding).toContainText('⌘⇧Y');
  await dialog.getByRole('button', { name: /Изменить сочетание: Открыть настройки/ }).click();
  await page.keyboard.press('Meta+Shift+U');
  await dialog.getByRole('button', { name: 'Готово' }).click();
  await page.keyboard.press('Meta+p');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Meta+Shift+Y');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Meta+Shift+Y');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Meta+Shift+U');
  await selectHotkeys();
  await expect(agentBinding).toContainText('⌘⇧Y');
  await dialog.getByRole('button', { name: 'Восстановить по умолчанию' }).click();
  await expect(agentBinding).toContainText('⌘P');
  await dialog.getByRole('button', { name: 'Готово' }).click();
  await page.keyboard.press('Meta+p');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Meta+,');
  await expect(dialog).toBeVisible();
});

test('Отправка захватывает контекст, опрашивает скрытое сообщение и показывает ссылку', { timeout }, async t => {
  // Arrange: сервер завершает сообщение только после разрешения теста.
  const { page, panel } = await open(t);
  state.releasePoll = false;
  await panel.getByRole('textbox', { name: 'Сообщение агенту' }).fill('Объясни поток');
  // Act: отправить и скрыть панель до завершения polling.
  await panel.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect.poll(() => state.submitted?.text).toBe('Объясни поток');
  await panel.getByRole('button', { name: 'Скрыть чат' }).click();
  await expect(page.getByRole('complementary', { name: 'Чат агента' })).toBeHidden();
  state.releasePoll = true;
  await expect.poll(() => state.polls).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Показать чат' }).click();
  // Assert: запрос содержит scoped URL и снимок фокуса, а ответ появился после раскрытия.
  const submit = state.requests.find(item => item.path.endsWith('/turns') && item.method === 'POST');
  assert.equal(submit.agentHeader, '1');
  assert.equal(submit.body.contextLimitTokens, 65536);
  assert.deepEqual(submit.body.focus, { kind: 'folder', folder: 'services' });
  assert.match(submit.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(await page.evaluate(() => window.fixtureCaptures), 1);
  await expect(panel.getByText('Ответ агента')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'docs/result.md:3' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.fixtureFinished)).toContainEqual(['docs/result.md']);
  await expect(panel.getByRole('button', { name: /Отменить правки|Обновить список отмены/ })).toHaveCount(0);
  assert.deepEqual(state.requests.filter(item => /^\/undo(?:\/|$)/.test(item.path)), []);
  await shot(page, 'chat-desktop-light');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.classList.add('dark');
  });
  await shot(page, 'chat-desktop-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'chat-mobile-dark');
});

test('Настройка контекста сохраняется и попадает в новый запрос', { timeout }, async t => {
  // Arrange: открыты настройки с лимитом по умолчанию.
  const { page, panel } = await open(t);
  await page.getByRole('button', { name: 'Открыть настройки' }).click();
  let dialog = page.getByRole('dialog', { name: 'Настройки' });
  await dialog.getByRole('option', { name: 'Контекст', exact: true }).click();
  let field = dialog.getByRole('textbox', { name: /Лимит контекста агента/ });
  await expect(field).toHaveValue('65536');

  // Act: изменить лимит и перезагрузить приложение.
  await field.fill('32768');
  await field.blur();
  await page.reload();
  await page.getByRole('button', { name: 'Открыть настройки' }).click();
  dialog = page.getByRole('dialog', { name: 'Настройки' });
  await dialog.getByRole('option', { name: 'Контекст', exact: true }).click();
  field = dialog.getByRole('textbox', { name: /Лимит контекста агента/ });

  // Assert: localStorage восстановил значение в обеих темах и на узком экране.
  await expect(field).toHaveValue('32768');
  await shot(page, 'settings-context-1440-light');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.classList.add('dark');
  });
  await shot(page, 'settings-context-1440-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'settings-context-390-dark');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.classList.remove('dark');
  });
  await shot(page, 'settings-context-390-light');

  // Act: закрыть настройки и отправить сообщение.
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole('button', { name: 'Готово' }).click();
  await panel.getByRole('textbox', { name: 'Сообщение агенту' }).fill('Используй сохранённый лимит');
  await panel.getByRole('button', { name: 'Отправить', exact: true }).click();

  // Assert: тело нового запроса содержит снимок сохранённой настройки.
  await expect.poll(() => state.submitted?.contextLimitTokens).toBe(32768);
});

test('Повторные polls обновляют фазу, а ошибка лимита шагов сохраняет usage и действия', { timeout }, async t => {
  // Arrange: один запрос последовательно возвращает два running-снимка и ошибку сервера.
  const { page, panel } = await open(t);
  state.releasePoll = false;
  const events = [
    { kind: 'plan' },
    { kind: 'model' },
    { kind: 'search', source: 'vault' },
    { kind: 'check', source: 'vault' }
  ];
  state.pollFrames = [
    { status: 'running', progress: { stepsUsed: 2, contextTokens: 120, contextLimitTokens: 600, events: events.slice(0, 2) } },
    { status: 'running', progress: { stepsUsed: 4, contextTokens: 240, contextLimitTokens: 600, events: events.slice(0, 3) } },
    { status: 'failed', progress: { stepsUsed: 5, contextTokens: 300, contextLimitTokens: 600, events },
      error: { code: 'agent_steps_exhausted', message: 'Исчерпан лимит внутренних шагов. Измените запрос.' } }
  ];
  await panel.getByRole('textbox', { name: 'Сообщение агенту' }).fill('Проверь архитектуру');

  // Act: отправить запрос и дождаться всех ответов одного running-turn.
  await panel.getByRole('button', { name: 'Отправить', exact: true }).click();
  const turn = panel.getByRole('article').filter({ hasText: 'Проверь архитектуру' });
  await expect(turn.getByText('Ожидает ответ модели', { exact: true })).toBeVisible({ timeout: assertionTimeout });
  await expect(turn.getByText('Ищет в хранилище', { exact: true })).toBeVisible({ timeout: assertionTimeout });
  await expect(turn.getByText('4', { exact: true })).toBeVisible();
  const gauge = panel.getByTestId('agent-context-progress');
  await expect(gauge).toHaveAccessibleName('Контекст разговора: 240/600');
  await expect(turn.getByRole('alert')).toContainText('Исчерпан лимит внутренних шагов. Измените запрос.');

  // Assert: после ошибки нет текущей фазы, но usage и упорядоченный журнал остались.
  await expect(turn.getByText('Проверяет схему', { exact: true })).toHaveCount(0);
  await expect(turn.getByText('5', { exact: true })).toBeVisible();
  await expect(gauge).toHaveAccessibleName('Контекст разговора: 300/600');
  await turn.getByRole('button', { name: 'Действия агента 4', exact: true }).click();
  const items = turn.getByRole('list', { name: 'Начатые действия' }).getByRole('listitem');
  await expect(items).toHaveText([
    'Составление плана',
    'Ожидание ответа модели',
    'Поиск в хранилище',
    'Проверка схемы'
  ]);
  await shot(page, 'chat-progress-failed-steps-1440-light');
});

test('Ошибка лимита контекста сохраняет сообщение сервера и ход запроса', { timeout }, async t => {
  // Arrange: история содержит завершённый ошибкой запрос с публичным прогрессом.
  const { page, panel } = await open(t);
  state.turns = [{
    id: turnOne, text: 'Прочитай большой документ', at: '2026-11-20T12:00:00Z', status: 'failed',
    error: { code: 'agent_context_too_large', message: 'Контекст модели заполнен. Сократите запрос.' },
    progress: {
      stepsUsed: 7, contextTokens: 15360, contextLimitTokens: 65536,
      events: [{ kind: 'read_vault', source: 'vault' }, { kind: 'model' }]
    }
  }];

  // Act: перезагрузить историю без активного polling.
  await page.reload();
  const turn = panel.getByRole('article').filter({ hasText: 'Прочитай большой документ' });

  // Assert: причина не заменена общей ошибкой, usage доступен и текущая фаза не показана.
  await expect(turn.getByRole('alert')).toContainText('Контекст модели заполнен. Сократите запрос.');
  await expect(turn.getByText('7', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('agent-context-progress')).toHaveAccessibleName('Контекст разговора: 15.4K/65.5K');
  await expect(turn.getByText('Ожидает ответ модели', { exact: true })).toHaveCount(0);
  await turn.getByRole('button', { name: 'Действия агента 2', exact: true }).click();
  await expect(turn.getByRole('list', { name: 'Начатые действия' })).toContainText('Чтение документа из хранилища');
});

test('Старый прогресс без лимита не заполняет шкалу контекста', { timeout }, async t => {
  // Arrange: сервер преобразовал старую запись и установил contextLimitTokens в ноль.
  const { page, panel } = await open(t);
  state.turns = [{
    id: turnOne, text: 'Покажи старый прогресс', at: '2026-11-20T12:00:00Z', status: 'failed',
    error: { code: 'model_unavailable', message: 'Модель не ответила.' },
    progress: { stepsUsed: 3, contextTokens: 300, contextLimitTokens: 0, events: [{ kind: 'plan' }] }
  }];

  // Act: загрузить преобразованную историю.
  await page.reload();
  const turn = panel.getByRole('article').filter({ hasText: 'Покажи старый прогресс' });
  const budgets = turn.locator('.agent-turn__budgets');

  // Assert: видны число шагов и пустая шкала с настроенным лимитом.
  await expect(budgets).toContainText('Шаги модели: 3');
  await expect(panel.getByTestId('agent-context-progress')).toHaveAccessibleName('Контекст разговора: 0/65.5K');
});

test('Подписи действий переводят фиксированные wire-источники на русский', { timeout }, async t => {
  // Arrange: журнал содержит все четыре значения Source из Rust и отдельное чтение Confluence.
  const { page, panel } = await open(t);
  state.turns = [{
    id: turnOne, text: 'Покажи работу с источниками', at: '2026-11-20T12:00:00Z', status: 'failed',
    error: { code: 'model_unavailable', message: 'Модель не ответила.' },
    progress: {
      stepsUsed: 6, contextTokens: 512, contextLimitTokens: 2048,
      events: [
        { kind: 'search', source: 'vault' },
        { kind: 'search', source: 'localCode' },
        { kind: 'search', source: 'remoteCode' },
        { kind: 'search', source: 'confluence' },
        { kind: 'read_source', source: 'confluence' },
        { kind: 'check', source: 'localCode' }
      ]
    }
  }];

  // Act: открыть начатые действия из сохранённой истории.
  await page.reload();
  const turn = panel.getByRole('article').filter({ hasText: 'Покажи работу с источниками' });
  await turn.getByRole('button', { name: 'Действия агента 6', exact: true }).click();

  // Assert: сырые enum-значения не попадают в UI, check всегда обозначает проверку схемы.
  await expect(turn.getByRole('list', { name: 'Начатые действия' }).getByRole('listitem')).toHaveText([
    'Поиск в хранилище',
    'Поиск в локальном коде',
    'Поиск в удалённом коде',
    'Поиск в Confluence',
    'Чтение страницы Confluence',
    'Проверка схемы'
  ]);
});

test('Визуальные состояния чата сохраняются в узкой панели и обеих темах', { timeout }, async t => {
  // Arrange: готовим один завершённый разговор и отдельные ответы для каждого состояния.
  const { page, panel } = await open(t);
  const states = [
    { name: 'populated', turns: [{ id: turnOne, text: 'Старый вопрос', at: '2026-11-20T12:00:00Z', status: 'done', answer: 'Старый ответ', cites: [], changed: [] }] },
    { name: 'empty', turns: [] },
    { name: 'running', turns: [{ id: turnOne, text: 'Проверь открытую схему', at: '2026-11-20T12:00:00Z', status: 'running' }] },
    { name: 'running-progress', turns: [{
      id: turnOne, text: 'Проверь открытую схему', at: '2026-11-20T12:00:00Z', status: 'running',
      progress: {
        stepsUsed: 4, contextTokens: 240, contextLimitTokens: 600,
        events: [{ kind: 'plan' }, { kind: 'model' }, { kind: 'check', source: 'vault' }]
      }
    }] },
    { name: 'failed', turns: [{ id: turnOne, text: 'Обнови документ', at: '2026-11-20T12:00:00Z', status: 'failed', error: { code: 'model_unavailable', message: 'Модель не ответила. Повторите запрос.' } }] }
  ];
  for (const item of states) {
    state.turns = item.turns;
    await page.reload();
    await expect(panel).toBeVisible({ timeout: assertionTimeout });
    for (const width of [1100, 820]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        // Act: переключаем только тему и ширину, состав сообщений остаётся неизменным.
        await page.evaluate(value => {
          document.documentElement.dataset.theme = value;
          document.documentElement.classList.toggle('dark', value === 'dark');
        }, theme);
        // Assert: снимок фиксирует реальное состояние панели без подмены DOM.
        await shot(page, `chat-${item.name}-${width}-${theme}`);
        assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      }
    }
  }
});

test('Markdown сохраняет безопасность и копирует ответ и код', { timeout }, async t => {
  // Arrange: ответ содержит fenced code, внешнюю ссылку, опасный URL и сырой HTML.
  const { page, panel } = await open(t);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  state.turns = [{
    id: turnOne,
    text: 'Покажи пример',
    at: '2026-11-20T12:00:00Z',
    status: 'done',
    answer: 'Пример ответа\n\n```ts\nconst answer = 42;\n```\n\n[Документация](https://example.com)\n\n[Опасная ссылка](javascript:alert(1))\n\n<img src=x onerror=alert(1)>',
    cites: [],
    changed: []
  }];
  await page.reload();
  await expect(panel.getByText('Пример ответа')).toBeVisible();
  // Act: копируем весь ответ и отдельный блок кода.
  await panel.getByRole('button', { name: 'Копировать ответ' }).click();
  const copiedAnswer = await page.evaluate(() => navigator.clipboard.readText());
  await panel.getByRole('button', { name: 'Копировать код' }).click();
  const copiedCode = await page.evaluate(() => navigator.clipboard.readText());
  // Assert: буфер получает исходный Markdown и код, опасный HTML и URL не выполняются.
  assert.match(copiedAnswer, /const answer = 42;/);
  assert.equal(copiedCode, 'const answer = 42;');
  await expect(panel.locator('img')).toHaveCount(0);
  await expect(panel.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Опасная ссылка' })).toHaveCount(0);
  const documentation = panel.getByRole('link', { name: 'Документация' });
  await expect(documentation).toHaveAttribute('target', '_blank');
  await expect(documentation).toHaveAttribute('rel', /noreferrer/);
  await shot(page, 'chat-markdown-1440-light');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.classList.add('dark');
  });
  await page.setViewportSize({ width: 820, height: 900 });
  await shot(page, 'chat-markdown-820-dark');
});

test('Длинный ответ и composer остаются в границах минимальной панели', { timeout }, async t => {
  // Arrange: длинный путь и строка кода создают широкое min-content-содержимое.
  const { page, panel } = await open(t);
  state.turns = [{
    id: turnOne,
    text: 'Покажи реализацию проверки заказа',
    at: '2026-11-20T12:00:00Z',
    status: 'done',
    answer: 'Проверка находится в обработчике.\n\n```ts\nexport function validateOrder(order: Order): ValidationResult { return validate(order.items); }\n```',
    cites: [{ kind: 'localCode', path: 'src/services/orders/validation/validateOrder.ts', line: 27 }],
    changed: []
  }];
  await page.reload();
  await expect(panel.getByText('Проверка находится в обработчике.')).toBeVisible();

  // Act: пользователь уменьшает панель до минимальной ширины клавиатурой.
  const separator = page.getByRole('separator', { name: 'Ширина чата агента' });
  await separator.focus();
  await separator.press('Home');

  // Assert: сообщения и кнопки composer не обрезаются справа; код прокручивается внутри блока.
  const bounds = await panel.evaluate(element => {
    const panelRect = element.getBoundingClientRect();
    const selectors = ['.agent-chat__messages', '.agent-chat__composer-shell', 'button[aria-label="Отправить"]', '.agent-chat__search'];
    return {
      horizontalOverflow: element.scrollWidth > element.clientWidth,
      escaped: selectors.filter(selector => {
        const target = element.querySelector(selector);
        return target !== null && target.getBoundingClientRect().right > panelRect.right;
      })
    };
  });
  assert.equal(bounds.horizontalOverflow, false);
  assert.deepEqual(bounds.escaped, []);
  await shot(page, 'chat-long-content-narrow-light');
});

test('История сохраняет черновики и выбранный разговор после перезагрузки', { timeout }, async t => {
  // Arrange: в первом разговоре есть незавершённый ввод.
  const { page, panel } = await open(t);
  await panel.getByRole('textbox', { name: 'Сообщение агенту' }).fill('Черновик первого');
  // Act: создать второй разговор, написать другой черновик и вернуться к первому.
  await panel.getByRole('button', { name: 'Новый разговор' }).click();
  await panel.getByRole('textbox', { name: 'Сообщение агенту' }).fill('Черновик второго');
  await panel.getByRole('button', { name: /История разговоров/ }).click();
  await page.getByRole('option', { name: 'Первый разговор' }).click();
  await expect(panel.getByRole('textbox', { name: 'Сообщение агенту' })).toHaveValue('Черновик первого');
  await page.reload();
  // Assert: localStorage восстановил выбор и текст, а API вернул прежнюю историю.
  const restored = page.getByRole('complementary', { name: 'Чат агента' });
  await expect(restored.getByRole('button', { name: /История разговоров/ })).toContainText('Первый разговор');
  await expect(restored.getByRole('textbox', { name: 'Сообщение агенту' })).toHaveValue('Черновик первого');
  await restored.getByRole('button', { name: /История разговоров/ }).click();
  await page.getByRole('option', { name: 'Разговор 2' }).click();
  await expect(restored.getByRole('textbox', { name: 'Сообщение агенту' })).toHaveValue('Черновик второго');
});

test('Клавиатурный разделитель сохраняет ширину панели', { timeout }, async t => {
  // Arrange: панель открыта с шириной по умолчанию.
  const { page, panel } = await open(t);
  const separator = page.getByRole('separator', { name: 'Ширина чата агента' });
  const initial = Number(await separator.getAttribute('aria-valuenow'));
  // Act: увеличить ширину клавишей и перезагрузить приложение.
  await separator.focus();
  await separator.press('ArrowLeft');
  const changed = Number(await separator.getAttribute('aria-valuenow'));
  assert.equal(changed, initial + 16);
  await page.reload();
  // Assert: размер и содержимое панели восстановлены.
  await expect(page.getByRole('separator', { name: 'Ширина чата агента' })).toHaveAttribute('aria-valuenow', String(changed));
  await expect(page.getByRole('complementary', { name: 'Чат агента' })).toBeVisible();
  await expect(panel.getByText('Старый ответ')).toBeVisible();
});

test('Привязка читает версию, выбирает локальную папку и сохраняет оба источника', { timeout }, async t => {
  // Arrange: точная папка ещё не имеет привязки.
  const { page } = await open(t);
  await page.getByRole('button', { name: 'Открыть привязку' }).click();
  const dialog = page.getByRole('dialog', { name: 'Привязка исходников' });
  await expect(dialog).toBeVisible();
  // Act: указать GitHub, выбрать каталог через native endpoint и сохранить.
  await dialog.getByRole('button', { name: /Провайдер/ }).click();
  await page.getByRole('option', { name: 'GitHub', exact: true }).click();
  await dialog.getByLabel('URL репозитория').fill('https://github.example/team/storage.git');
  await dialog.getByLabel('Ветка или ревизия').fill('main');
  await dialog.getByRole('button', { name: 'Выбрать папку' }).click();
  await expect(dialog.getByLabel('Локальная директория')).toHaveValue('/tmp/livenote-fixture-code');
  await shot(page, 'binding-desktop-light');
  await dialog.getByRole('button', { name: 'Сохранить привязку' }).click();
  // Assert: PUT получил точный folder, прежнюю версию и оба значения.
  const put = state.requests.find(item => item.path === '/binding' && item.method === 'PUT');
  assert.equal(put.query.folder, undefined);
  assert.equal(put.body.folder, 'services/storage');
  assert.equal(put.body.version, null);
  assert.deepEqual(put.body.value.repo, { provider: 'github', url: 'https://github.example/team/storage.git', ref: 'main' });
  assert.equal(put.body.value.localDir, '/tmp/livenote-fixture-code');
  await expect(dialog).toHaveCount(0);
});

test('Настройки показывают ошибку загрузки без списка подключений', { timeout }, async t => {
  // Arrange: API подключений возвращает ошибку вместо списка профилей.
  state.connectionsError = true;
  const { page } = await open(t);
  // Act: открыть общие настройки.
  await page.getByRole('button', { name: 'Открыть настройки' }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  await dialog.getByRole('option', { name: 'Модель', exact: true }).click();
  // Assert: ошибка находится вне регионов слотов, которые не загрузились.
  await expect(dialog.getByRole('alert')).toContainText('Хранилище подключений недоступно.');
  await expect(dialog.getByRole('region', { name: 'Модель' })).toHaveCount(0);
  state.connectionsError = false;
  await dialog.getByRole('button', { name: 'Повторить загрузку' }).click();
  await expect(dialog.getByRole('region', { name: 'Модель' })).toBeVisible();
});

test('Настройки сохраняют модель и токен без показа секрета', { timeout }, async t => {
  // Arrange: форма получила существующие профили из API.
  const { page } = await open(t);
  await page.getByRole('button', { name: 'Открыть настройки' }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  await dialog.getByRole('option', { name: 'Модель', exact: true }).click();
  const model = dialog.getByRole('region', { name: 'Модель' });
  await expect(model).toBeVisible();
  // Act: изменить адрес, модель и тестовый токен, затем сохранить.
  await model.getByLabel('Base URL').fill('http://127.0.0.1:9999/v1');
  await model.getByLabel('Модель', { exact: true }).fill('fixture-next');
  await model.getByLabel('Токен').fill('test-token-not-secret');
  await model.getByRole('button', { name: 'Сохранить подключение' }).click();
  // Assert: wire-форма содержит token, поле очищено, статус пришёл из ответа.
  await expect(model.getByLabel('Токен')).toHaveValue('');
  const put = state.requests.find(item => item.path === '/connections/model' && item.method === 'PUT');
  assert.deepEqual(put.body.profile, { kind: 'model', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture-next' });
  assert.deepEqual(put.body.secret, { kind: 'token', value: 'test-token-not-secret' });
  await expect(model.getByText('Подключено', { exact: true })).toBeVisible();
  await shot(page, 'settings-desktop-light');
});

test('OAuth сохраняет clientId и запускает серверный вход', { timeout }, async t => {
  // Arrange: открыт раздел GitHub с пустым секретом.
  const { page } = await open(t);
  await page.getByRole('button', { name: 'Открыть настройки' }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  await dialog.getByRole('option', { name: 'Интеграции', exact: true }).click();
  await dialog.getByRole('tab', { name: 'GitHub', exact: true }).click();
  const github = page.getByRole('region', { name: 'GitHub' });
  // Act: сохранить публичный clientId и вызвать OAuth.
  await github.getByLabel('OAuth client ID').fill('fixture-public-client');
  await github.getByRole('button', { name: 'Войти через браузер' }).click();
  // Assert: сначала PUT с oauth, затем POST без секретов в теле.
  await expect.poll(() => state.requests.some(item => item.path === '/connections/github/oauth' && item.method === 'POST')).toBe(true);
  const put = state.requests.find(item => item.path === '/connections/github' && item.method === 'PUT');
  assert.deepEqual(put.body.secret, { kind: 'oauth', clientId: 'fixture-public-client' });
  const oauth = state.requests.find(item => item.path === '/connections/github/oauth');
  assert.deepEqual(oauth.body, {});
});

test('Поиск настроек открывает нужное поле и возвращает фокус после закрытия', { timeout }, async t => {
  const { page } = await open(t);
  const trigger = page.getByRole('button', { name: 'Открыть настройки' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  const search = dialog.getByRole('searchbox', { name: 'Поиск настроек' });
  await expect(dialog.getByRole('option', { name: 'Внешний вид' })).toHaveAttribute('aria-selected', 'true');
  await search.fill('никаких совпадений');
  await expect(dialog.getByRole('status')).toContainText('Ничего не найдено');
  await search.fill('оформление диаграмм');
  await expect(dialog.getByRole('button', { name: /Тема Mermaid/ })).toBeVisible();
  await search.press('Enter');
  const mermaid = dialog.getByRole('button', { name: /Тема Mermaid/ });
  await expect(mermaid).toBeFocused();
  await mermaid.click();
  await page.getByRole('option', { name: 'forest', exact: true }).click();
  await expect(mermaid).toContainText('forest');
  await mermaid.click();
  await page.getByRole('option', { name: 'Как на сервере', exact: true }).click();
  await expect(mermaid).toContainText('Как на сервере');
  await expect(mermaid).toBeFocused();
  await expect(mermaid).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('На узком экране разделы и интеграции сохраняют черновики без записи на сервер', { timeout }, async t => {
  const { page } = await open(t);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole('button', { name: 'Открыть настройки' }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  await expect(dialog.getByRole('navigation', { name: 'Разделы настроек' })).toBeVisible();
  await shot(page, 'settings-nav-390-light');
  await dialog.getByRole('button', { name: 'Интеграции', exact: true }).click();
  const confluence = dialog.getByRole('region', { name: 'Confluence' });
  await confluence.getByLabel('Resource host').fill('draft.fixture');
  await dialog.getByRole('tab', { name: 'GitHub' }).click();
  await expect(dialog.getByRole('region', { name: 'GitHub' }).getByLabel('Resource host')).toHaveValue('github.fixture');
  await dialog.getByRole('button', { name: 'Назад к разделам' }).click();
  await expect(dialog.getByRole('button', { name: 'Интеграции', exact: true })).toBeFocused();
  await dialog.getByRole('searchbox', { name: 'Поиск настроек' }).fill('confluence');
  await dialog.getByRole('button', { name: /Confluence/ }).click();
  await expect(confluence.getByLabel('Resource host')).toHaveValue('draft.fixture');
  await expect(dialog.getByRole('tab', { name: 'Confluence' })).toHaveAttribute('aria-selected', 'true');
  const geometry = await dialog.evaluate(node => {
    const scroll = node.querySelector('[data-settings-content]');
    return { dialogWidth: node.clientWidth, scrollWidth: scroll.scrollWidth, viewWidth: scroll.clientWidth,
      verticallyScrollable: scroll.scrollHeight > scroll.clientHeight };
  });
  assert.equal(geometry.dialogWidth, 390);
  assert.equal(geometry.scrollWidth, geometry.viewWidth);
  assert.equal(geometry.verticallyScrollable, true);
  await dialog.getByRole('button', { name: 'Готово' }).click();
  await expect(dialog).toBeHidden();
  assert.deepEqual(state.requests.filter(item => item.method === 'PUT'), []);
  await page.getByRole('button', { name: 'Открыть настройки' }).click();
  await dialog.getByRole('button', { name: 'Интеграции', exact: true }).click();
  await expect(confluence.getByLabel('Resource host')).toHaveValue('confluence.fixture');
});

test('В каждом списке настроек галочка отмечает только выбранный вариант', { timeout }, async t => {
  const { page } = await open(t);
  await page.getByRole('button', { name: 'Открыть настройки' }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  for (const [label, initial] of [['Ширина страницы', 'Обычная'], ['Тема Mermaid', 'Как на сервере']]) {
    const trigger = dialog.getByRole('button', { name: new RegExp(label) });
    await trigger.click();
    const list = page.getByRole('listbox').filter({ has: page.getByRole('option', { name: initial, exact: true }) });
    const selected = list.getByRole('option', { selected: true });
    const icon = '[data-slot="list-box-item-indicator"] svg';
    await expect(selected).toHaveAccessibleName(initial);
    await expect(selected.locator(icon)).toBeVisible();
    await expect(list.getByRole('option', { selected: false }).locator(`${icon}:visible`)).toHaveCount(0);
    await shot(page, `settings-select-${initial === 'Обычная' ? 'width' : 'mermaid'}-light`);
    if (initial === 'Как на сервере') {
      await list.getByRole('option', { name: 'forest', exact: true }).click();
      await expect(list).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(selected).toHaveAccessibleName('forest');
      await expect(selected.locator(icon)).toBeVisible();
      await expect(list.getByRole('option', { selected: false }).locator(`${icon}:visible`)).toHaveCount(0);
    }
    await selected.press('Escape');
    await expect(list).toBeHidden();
  }
});

test('Настройки сохраняют фиксированную рамку и центрируют иконки в обеих темах', { timeout }, async t => {
  const { page } = await open(t);
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.getByRole('button', { name: 'Открыть настройки' }).click();
      const role = width >= 800 ? 'option' : 'button';
      const choose = name => dialog.getByRole(role, { name, exact: true });
      if (width < 800 && width === 390) await shot(page, `settings-navigation-${width}-${theme}`);
      for (const [section, title] of [['Внешний вид', 'appearance'], ['Редактор', 'editor'], ['Контекст', 'context'],
        ['Модель', 'model'], ['Интеграции', 'integrations']]) {
        await choose(section).click();
        await expect(dialog.getByRole('heading', { name: section, exact: true }).last()).toBeAttached();
        if (section === 'Модель') await expect(dialog.getByRole('region', { name: section })).toBeVisible();
        if (section === 'Интеграции') await expect(dialog.getByRole('region', { name: 'Confluence' })).toBeVisible();
        const frame = await dialog.evaluate(node => {
          const box = node.getBoundingClientRect();
          const scroller = node.querySelector('[data-settings-content]');
          const close = node.querySelector('[aria-label="Закрыть настройки"]');
          const a = close.getBoundingClientRect(), b = close.querySelector('svg').getBoundingClientRect();
          return {
            width: Math.round(box.width), height: Math.round(box.height), overflows: scroller.scrollWidth > scroller.clientWidth,
            dy: Math.abs(a.top + a.height / 2 - b.top - b.height / 2), icon: b.height
          };
        });
        assert.equal(frame.width, Math.min(width, 1000));
        assert.equal(frame.height, width >= 800 ? 636 : 700);
        assert.equal(frame.overflows, false);
        assert.equal(frame.icon, 16);
        assert.ok(frame.dy <= 1, `Иконка смещена на ${frame.dy} px`);
        if (width !== 320) await shot(page, `settings-${title}-${width}-${theme}`);
        if (width < 800) await dialog.getByRole('button', { name: 'Назад к разделам' }).click();
      }
      await dialog.getByRole('button', { name: 'Закрыть настройки' }).click();
      await expect(dialog).toBeHidden();
    }
  }
});
