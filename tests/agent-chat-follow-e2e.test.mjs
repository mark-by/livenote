import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expect } from 'playwright/test';
import { startAgentChatFixture } from './agent-chat-fixture.mjs';

const timeout = 60_000;
const originalNote = { title: 'Исходная', path: 'Исходная.md', source: '# Исходная\n' };
const deepLine = 180;
const marker = 'Глубокая строка заметки.';

function deepNote(path) {
  return {
    title: path.replace(/\.md$/, ''),
    path,
    source: Array.from({ length: 240 }, (_, index) => index + 1 === deepLine
      ? marker : `Строка ${index + 1}.`).join('\n')
  };
}

const editor = (page, path) => page.locator(`.vault-document[data-page-id="${path}"]`);
const read = (target) => ({ kind: 'read_vault', source: 'vault', target });

async function openFollowFixture(t, documents) {
  const token = 'agent-follow-fixture';
  const fixture = await startAgentChatFixture({ token, realApp: true });
  t.after(() => fixture.close());
  const state = fixture.reset();
  state.sessions = [];
  const pages = new URL('/api/pages', fixture.url);
  const createPage = async (document) => {
    const response = await fetch(pages, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(document)
    });
    assert.equal(response.status, 200, await response.text());
  };
  for (const document of [originalNote, ...documents]) await createPage(document);
  const { page, dialog } = await fixture.openLogin(t);
  page.setDefaultTimeout(8_000);
  // Идентификатор чата фикстуры не совпадает с идентификатором временного хранилища.
  await page.route(/\/api\/vaults\/vault-test\/(?:vault|pages)(?:[/?]|$)/, route => {
    const url = new URL(route.request().url());
    url.pathname = url.pathname.replace('/api/vaults/vault-test/', '/api/');
    return route.continue({ url: url.href });
  });
  let progress;
  let submitted;
  let completion;
  const events = [];
  const addEvent = event => {
    events.push(event);
    progress = { stepsUsed: events.length, contextTokens: 100, contextLimitTokens: 65_536, events: [...events] };
  };
  const complete = (answer, changed = []) => {
    completion = { ...submitted, status: 'done', answer, cites: [], changed, progress };
  };
  // Подменяем только ответ на сообщение и его запись в истории. Страницы читает обычный редактор.
  await page.route(/\/agent\/sessions\/[^/]+(?:\/turns(?:\/[^/]+)?)?$/, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/turns')) {
      const { id, text } = request.postDataJSON();
      submitted = { id, text, at: '2026-11-20T12:00:00Z', status: 'running' };
      return route.fulfill({ status: 202, json: submitted });
    }
    if (submitted && path.endsWith(`/turns/${submitted.id}`)) {
      return route.fulfill({ json: completion ?? { ...submitted, progress } });
    }
    if (completion && path.endsWith(`/sessions/${state.sessions[0].id}`)) {
      return route.fulfill({ json: { session: state.sessions[0], turns: [completion] } });
    }
    return route.fallback();
  });
  await dialog.getByLabel('Токен', { exact: true }).fill(token);
  await dialog.getByRole('button', { name: 'Открыть', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Чат агента' });
  await panel.getByRole('button', { name: 'Новый разговор', exact: true }).first().click();
  await expect(panel.getByRole('heading', { name: 'Спросите о проекте' })).toBeVisible();
  const baseline = editor(page, originalNote.path).locator('.cm-content');
  const tree = page.getByRole('navigation', { name: 'Файлы хранилища' });
  const original = tree.getByRole('button', { name: originalNote.title, exact: true });
  await original.click();
  await expect(baseline).toBeVisible();
  const follow = panel.getByRole('switch', { name: 'Следить за агентом', exact: true });
  const send = async (question) => {
    await panel.getByRole('textbox', { name: 'Сообщение агенту' }).fill(question);
    await panel.getByRole('button', { name: 'Отправить', exact: true }).click();
  };
  return { fixture, page, panel, baseline, follow, original, createPage, addEvent, complete, send };
}

test('Чат следует за агентом только по выбору пользователя и не повторяет переходы из истории', { timeout }, async t => {
  // Arrange: хранилище содержит две цели, а пользователь открывает другую заметку.
  const first = { title: 'Первая цель', path: 'First.md', source: '# Первая цель\n' };
  const second = deepNote('Second.md');
  const { fixture, page, panel, baseline, follow, original, addEvent, complete, send } =
    await openFollowFixture(t, [first, second]);
  await expect(follow).not.toBeChecked();

  // Act: пользователь отправляет сообщение и включает режим после первого чтения.
  addEvent(read({ path: second.path, line: deepLine }));
  await send('Сопоставь две заметки');
  const budgets = panel.getByLabel('Использованные ресурсы');
  await expect(budgets).toContainText(/Шаги модели:\s*1/);
  await expect(baseline).toBeVisible();
  await follow.press('Space');
  await expect(follow).toBeChecked();

  // Assert: новые события открывают обе заметки и показывают указанную строку.
  addEvent(read({ path: first.path }));
  await expect(editor(page, first.path).locator('.cm-content')).toBeVisible();
  addEvent(read({ path: second.path, line: deepLine }));
  await expect(editor(page, second.path).getByText(marker, { exact: true })).toBeInViewport();
  await fixture.shot(page, 'agent-chat-follow-deep-line');

  // Assert: история сохраняет ответ, но не открывает заметку вместо выбранной пользователем.
  const answer = 'Заметки прочитаны.';
  complete(answer);
  await expect(panel.getByText(answer, { exact: true })).toBeVisible();
  await original.click();
  await expect(baseline).toBeVisible();
  await page.reload();
  await expect(panel.getByText(answer, { exact: true })).toBeVisible();
  await expect(follow).toBeChecked();
  await expect(baseline).toBeVisible();
});

test('Чат открывает подготовленную заметку на указанной строке только после публикации', { timeout }, async t => {
  // Arrange: заметки ещё нет в хранилище, режим следования включён.
  const published = deepNote('Published.md');
  const { page, panel, baseline, follow, createPage, addEvent, complete, send } = await openFollowFixture(t, []);
  await follow.press('Space');
  await expect(follow).toBeChecked();
  addEvent({ kind: 'stage', target: { path: published.path, line: deepLine, pendingPublish: true } });

  // Act: агент подготавливает заметку, затем публикует её.
  await send('Подготовь новую заметку');
  await expect(panel.getByText('Подготавливает изменения', { exact: true })).toBeVisible();
  await expect(baseline).toBeVisible();
  await expect(editor(page, published.path)).toHaveCount(0);
  await createPage(published);
  const answer = 'Заметка опубликована.';
  complete(answer, [published.path]);

  // Assert: ответ завершён, а редактор показывает строку из события подготовки.
  await expect(panel.getByText(answer, { exact: true })).toBeVisible();
  await expect(editor(page, published.path).getByText(marker, { exact: true })).toBeInViewport();
});

test('Запоздалая загрузка заметки не меняет открытый документ после выключения режима', { timeout }, async t => {
  // Arrange: сервер удерживает ответ на загрузку цели, пока пользователь не выключит режим.
  const delayed = deepNote('Delayed.md');
  const { page, panel, baseline, follow, addEvent, complete, send } = await openFollowFixture(t, [delayed]);
  const path = `/api/vaults/vault-test/pages/${delayed.path}/document`;
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route(url => url.pathname === path, async route => {
    await release.promise;
    return route.fallback();
  });
  await follow.press('Space');
  await expect(follow).toBeChecked();
  addEvent(read({ path: delayed.path, line: deepLine }));
  const requested = page.waitForRequest(request => new URL(request.url()).pathname === path);
  await send('Прочитай заметку с задержкой');
  await requested;

  // Act: пользователь выключает режим до получения заметки.
  await follow.press('Space');
  await expect(follow).not.toBeChecked();
  const answer = 'Чтение завершено.';
  complete(answer);
  release.resolve();

  // Assert: клиент обработал завершение, но исходная заметка осталась открытой.
  await expect(panel.getByText(answer, { exact: true })).toBeVisible();
  await expect(baseline).toBeVisible();
  await expect(editor(page, delayed.path)).toHaveCount(0);
});
