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

const timeout = 420_000;

async function openChatWithReply(t, content) {
  const model = 'text-fixture';
  const requests = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let input = '';
    for await (const chunk of request) input += chunk;
    requests.push(JSON.parse(input));
    const body = JSON.stringify(chatCompletion(model, { content }));
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
  });
  provider.listen(0, '127.0.0.1');
  t.after(async () => {
    const closed = once(provider, 'close');
    provider.close();
    provider.closeAllConnections();
    await closed;
  });
  await once(provider, 'listening');
  const { port } = provider.address();
  const host = await startChatHost(t);
  await configureFixtureModel(host, { baseUrl: `http://127.0.0.1:${port}/v1`, model, token: 'local-text-fixture' });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(12_000);
  await page.goto(host.origin);
  const login = page.getByRole('dialog', { name: 'LiveNote защищён токеном' });
  await login.getByLabel('Токен', { exact: true }).fill(host.token);
  await login.getByRole('button', { name: 'Открыть', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Чат агента' });
  await panel.getByRole('button', { name: 'Новый разговор', exact: true }).first().click();
  await expect(panel.getByRole('heading', { name: 'Спросите о проекте' })).toBeVisible();
  return { page, panel, requests };
}

async function sendQuestion(panel, question) {
  await panel.getByRole('textbox', { name: 'Сообщение агенту' }).fill(question);
  await panel.getByRole('button', { name: 'Отправить', exact: true }).click();
  return panel.getByRole('article').filter({ hasText: question });
}

test('Чат LiveNote сразу обращается к Rig и один раз показывает ответ Markdown', { timeout }, async t => {
  // Arrange: локальная заглушка модели возвращает Markdown без вызова инструментов.
  const question = 'ping';
  const heading = 'Слышу вас';
  const answer = `## ${heading}\n\nГотов **помочь**.\n\n- Напишите вопрос.`;
  const { page, panel, requests } = await openChatWithReply(t, answer);

  // Act: отправляем вопрос через окно чата.
  const turn = await sendQuestion(panel, question);

  // Assert: первый и единственный запрос предлагает инструменты, а UI отображает Markdown.
  const reply = turn.getByRole('heading', { name: heading, exact: true });
  const fault = turn.getByRole('alert');
  await expect(reply.or(fault)).toBeVisible({ timeout: 12_000 });
  if (await fault.isVisible()) assert.fail(await fault.innerText());
  await expect(reply).toBeVisible();
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.messages.at(-1).content, question);
  assert.ok(request.tools?.some(tool => tool.type === 'function' && tool.function.name === 'read_vault'),
    'Первый запрос должен предлагать инструменты, а не вызывать планировщик.');
  assert.ok(request.tool_choice === undefined || request.tool_choice === 'auto',
    'Модель сама решает, вызывать ли инструменты.');
  const markdown = turn.locator('.agent-markdown');
  await expect(markdown).toHaveCount(1);
  await expect(reply).toHaveCount(1);
  await expect(markdown.locator('strong')).toHaveText('помочь');
  await expect(markdown.getByRole('listitem')).toHaveText('Напишите вопрос.');
  await expect(turn).not.toContainText(/"(answer|cites)"\s*:|## Слышу вас|\*\*помочь\*\*/);
  await expect(turn.getByRole('region', { name: 'Источники' })).toHaveCount(0);
  const evidence = await mkdtemp(join(tmpdir(), 'livenote-agent-markdown-'));
  const screenshot = join(evidence, 'markdown.png');
  await page.screenshot({ path: screenshot, animations: 'disabled' });
  t.diagnostic(`Ответ Markdown: ${screenshot}`);
});

test('Чат LiveNote показывает и копирует ответ без служебного итога', { timeout }, async t => {
  // Arrange: заглушка модели дописывает к обычному ответу служебный итог старого формата.
  const answer = 'Вместимость зала составляет 24 места.';
  const footer = 'LiveNote outcome for that request: {"changed":[],"cites":[],"searchPhrases":["capacity"]}';
  const { page, panel } = await openChatWithReply(t, `${answer}\n\n${footer}`);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });

  // Act: отправляем вопрос и нажимаем «Копировать ответ».
  const turn = await sendQuestion(panel, 'Сколько мест в зале?');
  const reply = turn.getByRole('region', { name: 'Ответ агента' });
  const copy = reply.getByRole('button', { name: 'Копировать ответ', exact: true });
  const fault = reply.getByRole('alert');
  await expect(copy.or(fault)).toBeVisible({ timeout: 12_000 });
  if (await fault.isVisible()) assert.fail(await fault.innerText());
  await copy.click();
  await expect(reply.getByRole('button', { name: 'Скопировано', exact: true })).toBeVisible();

  // Assert: служебный итог не попадает ни в видимый ответ, ни в буфер обмена.
  const markdown = reply.locator('.agent-markdown');
  assert.deepEqual(
    { displayed: await markdown.innerText(), copied: await page.evaluate(() => navigator.clipboard.readText()) },
    { displayed: answer, copied: answer }
  );
});
