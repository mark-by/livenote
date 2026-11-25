import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { chatCompletion } from './helpers/agent-chat-completion.mjs';
import { configureFixtureModel, startChatHost } from './helpers/agent-chat-desktop-host.mjs';

const timeout = 120_000;
const model = 'drawio-fixture';
const question = 'Создай страницу со схемой draw.io';
const pagePath = 'process.md';
const markdown = '# Процесс\n';
const title = 'Начало';
const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Start" parent="1" vertex="1"><mxGeometry x="10" y="20" width="50" height="40" as="geometry"/></mxCell></root></mxGraphModel>';

test('Rust HTTP публикует страницу и проверенное вложение draw.io', { timeout }, async t => {
  // Arrange: HTTP-сервер использует Chromium и временное хранилище.
  const fixture = await startModel(t);
  const executable = process.env.LIVENOTE_CHAT_FIXTURE_CHROMIUM ?? chromium.executablePath();
  const host = await startChatHost(t, {}, executable);
  await configureFixtureModel(host, fixture);
  const session = randomUUID();
  const id = randomUUID();
  await agentRequest(host, '/sessions', { id: session });

  // Act: отправляем сообщение и ждём завершения публикации.
  const turns = `/sessions/${session}/turns`;
  await agentRequest(host, turns, { id, text: question, search: 'docsFirst', focus: { kind: 'folder', folder: '' } });
  let turn;
  await expect.poll(async () => {
    turn = await agentRequest(host, `${turns}/${id}`);
    return turn.status;
  }, { timeout: 30_000 }).not.toBe('running');

  // Assert: страница ссылается на вложение из ответа инструмента. XML сохраняется без изменений.
  assert.equal(turn.status, 'done', JSON.stringify(turn));
  const assetPath = turn.answer.slice('Диаграмма: '.length);
  assert.equal(turn.answer, `Диаграмма: ${assetPath}`);
  assert.match(assetPath, /\.drawio$/);
  assert.deepEqual([...turn.changed].sort(), [pagePath, assetPath].sort());
  const note = await readFile(join(host.vault, pagePath), 'utf8');
  assert.ok(note.startsWith(markdown), note);
  const embed = note.match(/^!\[Начало\]\(([^)\r\n]+)\)$/m);
  assert.ok(embed, note);
  assert.equal(posix.join(posix.dirname(pagePath), decodeURIComponent(embed[1])), assetPath);
  assert.equal(await readFile(join(host.vault, assetPath), 'utf8'), source);
  t.diagnostic(`Chromium: ${executable}; опубликованы ${pagePath} и ${assetPath}.`);
});

async function agentRequest(host, path, body) {
  const response = await fetch(`${host.agentBase}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', 'X-LiveNote-Agent': '1' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5_000)
  });
  const text = await response.text();
  assert.equal(response.status, path.endsWith('/turns') ? 202 : 200, text);
  return JSON.parse(text);
}

async function startModel(t) {
  const token = randomUUID();
  let step = 0;
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      let body = '';
      for await (const chunk of req) body += chunk;
      const reply = modelReply(step++, JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(chatCompletion(model, reply)));
    } catch (error) {
      failures.push(String(error));
      res.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    assert.deepEqual(failures, []);
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model, token };
}

function modelReply(step, input) {
  const stageResult = id => {
    const message = input.messages.at(-1);
    assert.equal(message.role, 'tool');
    assert.equal(message.tool_call_id, id);
    const result = JSON.parse(message.content);
    assert.equal(result.staged, true, message.content);
    return result;
  };
  const call = (name, args) => {
    assert.ok(input.tools.some(tool => tool.type === 'function' && tool.function.name === name),
      `Модель не получила инструмент ${name}.`);
    return { content: null, tool_calls: [{
      type: 'function', id: `call-${step}`, function: { name, arguments: JSON.stringify(args) }
    }] };
  };
  switch (step) {
    case 0: return call('stage', { kind: 'create', path: pagePath, source: markdown });
    case 1:
      assert.equal(input.tools, undefined);
      assert.equal(input.messages.at(-1).content, question);
      return { content: JSON.stringify({ write: 'allow' }) };
    case 2:
      stageResult('call-0');
      return call('stage_diagram', { pagePath, format: 'drawio', source, title });
    case 3: {
      const { diagram } = stageResult('call-2');
      assert.equal(diagram.pagePath, pagePath);
      assert.equal(diagram.validation.syntax, 'ok');
      assert.equal(diagram.validation.renderer, 'playwright');
      assert.match(diagram.assetPath, /\.drawio$/);
      return { content: `Диаграмма: ${diagram.assetPath}` };
    }
    default: return assert.fail(`Неожиданный запрос модели: шаг ${step}.`);
  }
}
