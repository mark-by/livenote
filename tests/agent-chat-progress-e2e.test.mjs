import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { chatCompletion } from './helpers/agent-chat-completion.mjs';
import { configureFixtureModel, startChatHost } from './helpers/agent-chat-desktop-host.mjs';

test('Desktop-чат показывает публичный прогресс во время отложенного ответа модели', { timeout: 120_000 }, async t => {
  // Arrange: поставщик удерживает первый ответ до явного разрешения теста.
  const answer = 'Маяк янтарный.';
  const model = 'delayed-fixture';
  let releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  let releaseFinal;
  const final = new Promise(resolve => { releaseFinal = resolve; });
  const requests = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let input = '';
    for await (const chunk of request) input += chunk;
    const requestBody = JSON.parse(input);
    const step = requests.push(requestBody);
    const last = requestBody.messages.at(-1);
    const message = (() => {
      switch (step) {
        case 1: return { content: null, tool_calls: [{
          id: 'call_progress_read', type: 'function', function: {
            name: 'read_vault', arguments: JSON.stringify({ path: 'Регламент.md', lines: { first: 1, last: 3 } })
          }
        }] };
        case 2: return { content: null, tool_calls: [{
          id: 'call_progress_cite', type: 'function', function: {
            name: 'cite', arguments: JSON.stringify({ refs: [JSON.parse(last.content).readId] })
          }
        }] };
        case 3: return { content: answer };
        default: return null;
      }
    })();
    if (!message) return response.writeHead(500).end();
    if (step === 1) await first;
    if (step === 2) await final;
    const body = JSON.stringify(chatCompletion(model, message));
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
  });
  provider.listen(0, '127.0.0.1');
  t.after(async () => {
    releaseFirst();
    releaseFinal();
    const closed = once(provider, 'close');
    provider.close();
    provider.closeAllConnections();
    await closed;
  });
  await once(provider, 'listening');
  const { port } = provider.address();
  const host = await startChatHost(t);
  await configureFixtureModel(host, { baseUrl: `http://127.0.0.1:${port}/v1`, model, token: 'local-delayed-fixture' });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(12_000);
  await page.goto(host.origin);
  const login = page.getByRole('dialog', { name: 'LiveNote защищён токеном' });
  await login.getByLabel('Токен', { exact: true }).fill(host.token);
  await login.getByRole('button', { name: 'Открыть', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Чат агента' });
  await panel.getByRole('button', { name: 'Новый разговор', exact: true }).first().click();
  await expect(panel.getByRole('heading', { name: 'Спросите о проекте' })).toBeVisible();

  // Act: реальный UI отправляет запрос, а модель ещё не отвечает.
  await panel.getByRole('textbox', { name: 'Сообщение агенту' }).fill('ping с задержкой');
  await panel.getByRole('button', { name: 'Отправить', exact: true }).click();

  // Assert: первый вызов модели виден до получения ответа.
  const turn = panel.getByRole('article').filter({ hasText: 'ping с задержкой' });
  const waiting = turn.getByText('Ожидает ответ модели', { exact: true });
  const budgets = turn.getByLabel('Использованные ресурсы');
  await expect(waiting).toBeVisible();
  await expect(budgets).toContainText(/Шаги модели:\s*1/);
  await expect(turn.getByText(answer, { exact: true })).toHaveCount(0);

  // Act: модель запрашивает чтение заметки, а следующий ответ остаётся задержанным.
  releaseFirst();

  // Assert: новый снимок прогресса показывает чтение заметки и второй вызов модели.
  try {
    await expect(budgets).toContainText(/Шаги модели:\s*2/);
    await expect(waiting).toBeVisible();
    await turn.getByRole('button', { name: /^Действия агента/ }).click();
    const events = turn.getByRole('list', { name: 'Начатые действия' }).getByRole('listitem');
    await expect(events).toHaveText([
      'Ожидание ответа модели', 'Чтение документа из хранилища', 'Ожидание ответа модели'
    ]);
  } catch (error) {
    t.diagnostic(`Содержимое running-turn: ${await turn.innerText()}`);
    const failedShot = await mkdtemp(join(tmpdir(), 'livenote-agent-progress-e2e-failed-'));
    await page.screenshot({ path: join(failedShot, 'running.png'), fullPage: true, animations: 'disabled' });
    t.diagnostic(`Снимок ошибки: ${join(failedShot, 'running.png')}`);
    throw error;
  }
  const gauge = panel.getByTestId('agent-context-progress');
  const measuredContext = /^Контекст разговора: [1-9][\d.]*K?\/65\.5K$/;
  await expect(gauge).toHaveAccessibleName(measuredContext);
  await expect(turn.getByText(answer, { exact: true })).toHaveCount(0);
  const evidence = await mkdtemp(join(tmpdir(), 'livenote-agent-progress-e2e-'));
  await page.screenshot({ path: join(evidence, 'running.png'), fullPage: true, animations: 'disabled' });
  t.diagnostic(`Снимок running: ${join(evidence, 'running.png')}`);

  // Act: разрешить основной ответ поставщика.
  releaseFinal();

  // Assert: ответ заменяет текущую фазу, а фактический usage остаётся в истории.
  await expect(turn.getByText(answer, { exact: true })).toBeVisible();
  await expect(waiting).toHaveCount(0);
  await expect(budgets).toContainText(/Шаги модели:\s*3/);
  await expect(gauge).toHaveAccessibleName(measuredContext);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].messages.at(-1).tool_call_id, 'call_progress_read');
  await page.screenshot({ path: join(evidence, 'done.png'), fullPage: true, animations: 'disabled' });
  t.diagnostic(`Снимок done: ${join(evidence, 'done.png')}`);
});
