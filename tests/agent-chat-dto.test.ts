import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentTurnSchema } from '../src/web/agent/agentSchemas.ts';
import {
  AGENT_HEADER,
  AGENT_HEADER_VALUE,
  AGENT_OAUTH_CALLBACK_PATH,
  agentApiBase,
  type AgentBindingRequest,
  type AgentCite,
  type AgentFocus,
  type AgentProfile,
  type AgentSecretChange,
  type AgentSubmit,
  type AgentTurn
} from '../src/shared/types.ts';

/** Проверяется только компилятором: в рантайме тест пуст по замыслу. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertSameType = <T extends true>(): void => {};

test('константы HTTP-протокола агента совпадают с контрактом', () => {
  assert.equal(AGENT_HEADER, 'X-LiveNote-Agent');
  assert.equal(AGENT_HEADER_VALUE, '1');
  assert.equal(AGENT_OAUTH_CALLBACK_PATH, '/api/agent/oauth/callback');
});

test('agentApiBase строит базу маршрутов с кодированием vaultId', () => {
  assert.equal(agentApiBase('0e1c9a2e'), '/api/vaults/0e1c9a2e/agent');
  assert.equal(agentApiBase('a/b'), '/api/vaults/a%2Fb/agent');
});

test('wire-формы вариантов фокуса и сообщения держат имена полей', () => {
  const folderFocus: AgentFocus = { kind: 'folder', folder: 'docs' };
  const diagramFocus: AgentFocus = {
    kind: 'diagram',
    path: 'schemas/main.bpmn',
    base: { revision: 3, version: 'sha256:aa' },
    format: 'bpmn',
    target: { kind: 'inline', from: 0, to: 128 },
    selected: [{ id: 'Task_1', kind: 'node' }]
  };
  const submit: AgentSubmit = {
    id: '6f0a-4c',
    text: 'добавь обработку ошибки',
    search: 'docsFirst',
    focus: folderFocus,
    contextLimitTokens: 65536
  };

  assert.deepEqual(Object.keys(diagramFocus).sort(), [
    'base', 'format', 'kind', 'path', 'selected', 'target'
  ]);
  assert.deepEqual(Object.keys(submit).sort(), ['contextLimitTokens', 'focus', 'id', 'search', 'text']);
});

test('статусы сообщения агента несут разные наборы полей', () => {
  const running: AgentTurn = { id: 't1', text: 'вопрос', at: '2026-11-20T10:00:00Z', status: 'running' };
  const done: AgentTurn = {
    id: 't2',
    text: 'вопрос',
    at: '2026-11-20T10:00:00Z',
    status: 'done',
    answer: 'ответ',
    cites: [],
    changed: ['docs/api.md']
  };
  const failed: Extract<AgentTurn, { status: 'failed' }> = {
    id: 't3',
    text: 'вопрос',
    at: '2026-11-20T10:00:00Z',
    status: 'failed',
    error: { code: 'busy', message: 'уже выполняется операция' }
  };

  assert.deepEqual(Object.keys(running).sort(), ['at', 'id', 'status', 'text']);
  assert.deepEqual(Object.keys(done).sort(), ['answer', 'at', 'changed', 'cites', 'id', 'status', 'text']);
  assert.deepEqual(Object.keys(failed.error).sort(), ['code', 'message']);
});

test('клиент сохраняет координаты действия из ответа сервера', () => {
  // Arrange: агент подготовил новую страницу, которой пока нет в дереве.
  const action = { kind: 'stage', target: { path: 'docs/api.md', line: 12, pendingPublish: true } };
  const progress = { stepsUsed: 1, contextTokens: 200, contextLimitTokens: 65536, events: [action] };

  // Act: клиент разбирает ответ опроса хода.
  const turn = agentTurnSchema.parse({ id: 't1', text: 'Создай страницу', at: '2026-11-20T10:00:00Z', status: 'running', progress });

  // Assert: координаты и признак ожидания публикации доступны редактору.
  assert.deepEqual(turn.progress, progress);
});

test('варианты ссылки, привязки и профиля держат свои поля', () => {
  const vaultCite: AgentCite = { kind: 'vault', path: 'docs/api.md', line: 12 };
  const remoteCite: AgentCite = { kind: 'remoteCode', url: 'https://gitlab/x/-/blob/a.ts', path: 'a.ts', line: 3 };
  const bindingRequest: AgentBindingRequest = {
    folder: 'services/storage',
    value: { repo: { provider: 'gitlab', url: 'https://gitlab/x/y.git' }, localDir: null },
    version: 'sha256:bb'
  };
  const modelProfile: AgentProfile = { kind: 'model', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen' };
  const mcpProfile: AgentProfile = { kind: 'confluence', endpoint: 'https://confluence', resourceHost: 'confluence.example' };
  const tokenChange: AgentSecretChange = { kind: 'token', value: 'secret' };

  assert.deepEqual(Object.keys(vaultCite).sort(), ['kind', 'line', 'path']);
  assert.deepEqual(Object.keys(remoteCite).sort(), ['kind', 'line', 'path', 'url']);
  assert.deepEqual(Object.keys(bindingRequest).sort(), ['folder', 'value', 'version']);
  assert.deepEqual(Object.keys(modelProfile).sort(), ['baseUrl', 'kind', 'model']);
  assert.deepEqual(Object.keys(mcpProfile).sort(), ['endpoint', 'kind', 'resourceHost']);
  assert.deepEqual(Object.keys(tokenChange).sort(), ['kind', 'value']);
});

test('агентные типы совпадают с контрактными формами', () => {
  assertSameType<Equal<AgentFocus, AgentSubmit['focus']>>();
  assertSameType<Equal<AgentSecretChange, { kind: 'keep' } | { kind: 'clear' } | { kind: 'token'; value: string } | { kind: 'oauth'; clientId: string }>>();
  assertSameType<Equal<ReturnType<typeof agentApiBase>, string>>();
});

test('невозможные wire-значения отклоняются компилятором', () => {
  // @ts-expect-error неизвестный вариант фокуса не входит в AgentFocus
  const focus: AgentFocus = { kind: 'page', folder: 'docs' };
  // @ts-expect-error у Submit обязательны id, text, search и focus
  const submit: AgentSubmit = { text: 'вопрос', search: 'docsFirst', focus };

  void submit;
});
