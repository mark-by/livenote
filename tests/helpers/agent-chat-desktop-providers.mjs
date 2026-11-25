import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { bpmnAnswer, bpmnPagePath, bpmnPageTitle, bpmnQuestion, bpmnSource, bpmnTitle } from './agent-chat-bpmn-fixture.mjs';
import { chatCompletion } from './agent-chat-completion.mjs';

export const model = 'desktop-fixture';
export const localTerm = 'янтарный';
export const remoteTerm = 'фиолетовый';
const remoteQuery = 'резервный сигнал';
export const docsQuestion = 'Какого цвета маяк по регламенту?';
export const overviewQuestion = 'Для чего нужна эта система?';
export const overviewAnswer = 'Система собирает телеметрию с метеостанций.';
export const mcpQuestion = 'Какого цвета резервный сигнал по Confluence?';
export const editQuestion = 'Обнови обе заметки, добавь отметку «Проверено».';
export const diagramTitle = 'Приём заявки';
export const diagramFile = `${diagramTitle}.md`;
export const diagramQuestion = `Создай страницу «${diagramTitle}» со схемой Mermaid: принять заявку, затем проверить данные.`;
export const diagramAnswer = 'Создал страницу со схемой процесса.';
const diagramSource = 'flowchart LR\n  receive["Принять заявку"]\n  validate["Проверить данные"]\n  receive --> validate';
export const diagramMarkdown = `# ${diagramTitle}\n\n\`\`\`mermaid\n${diagramSource}\n\`\`\`\n`;
export const remoteTitle = 'Резервный сигнал';
export const originals = {
  'Регламент.md': '# Регламент\n\nЦвет маяка: янтарный.\n',
  'Журнал.md': '# Журнал\n\nЗапись о запуске.\n'
};
export const overviewFile = 'README.md';
export const marker = '\nПроверено.\n';

const content = value => ({ content: JSON.stringify(value) });
const answer = text => ({ content: text });
const toolCall = (input, name, args) => {
  assert.equal(input.parallel_tool_calls, false);
  const definition = input.tools?.find(tool => tool.type === 'function' && tool.function.name === name);
  assert.ok(definition, `Модель не получила описание инструмента ${name}.`);
  return { content: null, tool_calls: [{
    type: 'function', id: `call_${randomUUID()}`, function: { name, arguments: JSON.stringify(args) }
  }] };
};

function toolResult(messages, expectedCall) {
  if (!expectedCall) return null;
  const [assistant, result] = messages.slice(-2);
  assert.equal(assistant.role, 'assistant');
  const call = assistant.tool_calls?.find(call => call.id === expectedCall.id);
  assert.equal(call?.type, 'function');
  assert.equal(call.function.name, expectedCall.function.name);
  assert.deepEqual(JSON.parse(call.function.arguments), JSON.parse(expectedCall.function.arguments));
  assert.equal(result.role, 'tool');
  assert.equal(result.tool_call_id, expectedCall.id);
  return JSON.parse(result.content);
}

function docsReply(step, call, result) {
  switch (step) {
    case 0: return call('search', { text: localTerm, limit: 5 });
    case 1: {
      assert.equal(result.source, 'vault');
      const [hit] = result.hits;
      assert.equal(hit.cite.path, 'Регламент.md');
      assert.match(hit.excerpt, /янтарный/);
      return call('cite', { refs: [hit.ref] });
    }
    case 2:
      assert.deepEqual(result, { cited: true });
      return answer('По регламенту маяк **янтарный**.');
    default: assert.fail(`Лишний запрос модели: поиск по vault, шаг ${step}`);
  }
}

function overviewReply(step, call, result) {
  switch (step) {
    case 0: return call('read_vault', { path: overviewFile, lines: { first: 1, last: 3 } });
    case 1:
      assert.ok(result.fragment.text.includes(overviewAnswer));
      return call('cite', { refs: [result.readId] });
    case 2:
      assert.deepEqual(result, { cited: true });
      return answer(overviewAnswer);
    default: assert.fail(`Лишний запрос модели: обзор проекта, шаг ${step}`);
  }
}

function mcpReply(step, call, result) {
  switch (step) {
    case 0: return call('search', { text: remoteQuery, limit: 5 });
    case 1:
      assert.deepEqual(result.hits, []);
      return call('next_source', {});
    case 2: return call('search', { remoteIndex: 0, limit: 5 });
    case 3:
      assert.equal(result.source, 'confluence');
      return call('read_source', { ref: result.hits[0].ref, lines: { first: 2, last: 2 } });
    case 4:
      assert.equal(result.text, remoteTerm);
      return call('cite', { refs: [result.ref] });
    case 5:
      assert.deepEqual(result, { cited: true });
      return answer('Резервный сигнал фиолетовый.');
    default: assert.fail(`Лишний запрос модели: поиск в MCP, шаг ${step}`);
  }
}

function editReply(step, call, result) {
  const paths = Object.keys(originals);
  switch (step) {
    case 0: return call('read_vault', { path: paths[0], lines: { first: 1, last: 3 } });
    case 1:
    case 3: {
      const path = paths[(step - 1) / 2];
      const end = originals[path].lastIndexOf('\n');
      return call('stage', {
        kind: 'patch', readId: result.readId, layout: 'preserve',
        edits: [{ from: end, to: end, old: '', text: `\n${marker.trimEnd()}` }]
      });
    }
    case 2:
      assert.equal(result.staged, true);
      return call('read_vault', { path: paths[1], lines: { first: 1, last: 3 } });
    case 4:
      assert.equal(result.staged, true);
      return answer('Отметка добавлена в обе заметки.');
    default: assert.fail(`Лишний запрос модели: правка, шаг ${step}`);
  }
}

function diagramReply(step, call, result) {
  switch (step) {
    case 0: return call('stage', { kind: 'create', path: diagramFile, source: diagramMarkdown });
    case 1:
      assert.equal(result.staged, true);
      return answer(diagramAnswer);
    default: assert.fail(`Лишний запрос модели: создание страницы со схемой, шаг ${step}`);
  }
}

function bpmnReply(calls, step, call, result) {
  switch (step) {
    case 0:
      return call('stage', { kind: 'create', path: bpmnPagePath, source: `# ${bpmnPageTitle}\n` });
    case 1:
      assert.equal(result.staged, true);
      return call('stage_diagram', { pagePath: bpmnPagePath, format: 'bpmn', source: bpmnSource, title: bpmnTitle });
    case 2: {
      assert.equal(result.staged, true);
      const { pagePath, assetPath } = result.diagram;
      assert.equal(pagePath, bpmnPagePath);
      assert.match(assetPath, /\.bpmn$/);
      calls.diagram.push({ pagePath, assetPath });
      return answer(bpmnAnswer);
    }
    default:
      assert.fail(`Лишний запрос модели: создание BPMN, шаг ${step}`);
  }
}

function policyReply(input, question, state) {
  assert.deepEqual(input.messages.map(message => message.role), ['system', 'user']);
  assert.equal(input.messages.at(-1).content, question);
  assert.equal(state.policy, undefined, 'Повторный вызов классификатора в том же сообщении.');
  if (question === mcpQuestion && state.expectedCall?.function.name === 'search' && state.step === 3) {
    return content({ remoteQueries: [remoteQuery] });
  }
  if ([editQuestion, diagramQuestion, bpmnQuestion].includes(question) && state.expectedCall?.function.name === 'stage') {
    return content({ write: 'allow' });
  }
  assert.fail(`Незапрошенная классификация: ${question}, шаг ${state.step}`);
}

function mcpResult(input) {
  const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  switch (input.method) {
    case 'initialize':
      return { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: model, version: '1' } };
    case 'tools/list':
      return { tools: [
        { name: 'confluence_search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } } },
        { name: 'confluence_get_page', inputSchema: { type: 'object', properties: {
          page_id: { type: 'string' }, include_metadata: { type: 'boolean' }, convert_to_markdown: { type: 'boolean' }
        } } }
      ] };
    case 'tools/call': {
      const { name, arguments: args } = input.params;
      if (name === 'confluence_search') {
        assert.equal(args.query, `type = page AND text ~ "${remoteQuery}"`);
        return text([{ id: '10', title: remoteTitle, url: '/wiki/10', excerpt: remoteTerm }]);
      }
      assert.equal(name, 'confluence_get_page');
      assert.equal(args.page_id, '10');
      return text({ content: { value: `Памятка\n${remoteTerm}\n` } });
    }
    default: assert.fail(`Неизвестный метод MCP: ${input.method}`);
  }
}

export async function providers(t) {
  const token = randomUUID();
  const calls = { model: [], policy: [], mcp: [], diagram: [], errors: [] };
  const scripts = new Map([
    [docsQuestion, docsReply], [mcpQuestion, mcpReply], [editQuestion, editReply],
    [overviewQuestion, overviewReply], [diagramQuestion, diagramReply], [bpmnQuestion, bpmnReply.bind(null, calls)]
  ]);
  const steps = new Map();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/wiki/10') {
        return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(remoteTitle);
      }
      if (req.method === 'GET' && req.url === '/favicon.ico') return res.writeHead(404).end();
      assert.equal(req.method, 'POST', `Неожиданный запрос: ${req.method} ${req.url}`);
      assert.equal(req.headers.authorization, `Bearer ${token}`, 'Провайдер не получил тестовый bearer.');
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      let output;
      if (req.url === '/v1/chat/completions') {
        assert.equal(input.model, model);
        assert.equal(input.stream, false);
        assert.equal(body.includes(token), false, 'Токен попал в контекст модели.');
        const question = input.messages.findLast(message =>
          message.role === 'user' && scripts.has(message.content)
        )?.content;
        const script = scripts.get(question);
        assert.ok(script, `Нет сценария для сообщения: ${question}`);
        const state = steps.get(question) ?? { step: 0 };
        if (!input.tools?.length) {
          const message = policyReply(input, question, state);
          calls.policy.push(question);
          output = chatCompletion(model, message);
          steps.set(question, { ...state, policy: true });
        } else {
          const result = toolResult(input.messages, state.expectedCall);
          calls.model.push(question);
          const message = script(state.step, (name, args) => toolCall(input, name, args), result);
          output = chatCompletion(model, message);
          steps.set(question, { ...state, step: state.step + 1, expectedCall: message.tool_calls?.[0] });
        }
      } else {
        assert.equal(req.url, '/mcp');
        calls.mcp.push(input.params?.name ?? input.method);
        if (input.method === 'notifications/initialized') return res.writeHead(202).end();
        output = { jsonrpc: '2.0', id: input.id, result: mcpResult(input) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(output));
    } catch (error) {
      calls.errors.push(String(error));
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
    t.diagnostic(`Запросы к провайдерам: ${JSON.stringify(calls)}`);
    assert.deepEqual(calls.errors, []);
  });
  const resourceHost = `127.0.0.1:${server.address().port}`;
  return { token, calls, resourceHost, base: `http://${resourceHost}` };
}
