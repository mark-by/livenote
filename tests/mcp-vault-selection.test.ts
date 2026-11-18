import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { NoteStore } from '../src/server/db.js';
import { AppError } from '../src/server/errors.js';
import { mountMcp } from '../src/server/mcp/mcpEndpoint.js';
import type { ServerDeps } from '../src/server/ports.js';
import { NoteService } from '../src/server/services.js';
import { UnavailableBpmnValidator } from '../src/server/validator/bpmn.js';
import { UNAVAILABLE } from '../src/server/validator/playwright.js';
import { VaultStore } from '../src/server/vault.js';
import type { DiagramValidator } from '../src/shared/types.js';

const personal = { id: 'personal', name: 'Personal' } as const;
const team = { id: 'team', name: 'Team' } as const;
const sharedPath = 'Same.md';
const documentText = z.object({ source: z.string() });
const pageList = z.array(z.object({ id: z.string() }));

function dependencies(store: VaultStore | NoteStore): ServerDeps {
  const broadcaster = { publish() {} };
  const validator: DiagramValidator = {
    kind: 'unavailable',
    parse: async () => UNAVAILABLE,
    render: async () => ({ validation: UNAVAILABLE })
  };
  return {
    broadcaster,
    service: new NoteService(store, broadcaster, validator, new UnavailableBpmnValidator(), validator),
    config: { port: 0, host: '127.0.0.1', dbPath: ':memory:', token: null, openBrowser: false, mermaidTheme: 'default' }
  };
}

async function connect(t: TestContext, deps: ServerDeps, vaults?: Parameters<typeof mountMcp>[2]) {
  const app = express();
  mountMcp(app, deps, vaults);
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const client = new Client({ name: 'vault-selection-test', version: '1' });
  t.after(async () => {
    try {
      await client.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  return client;
}

async function vaultFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'livenote-mcp-vaults-'));
  const stores = new Map<string, VaultStore>();
  t.after(() => {
    for (const store of stores.values()) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const open = new Map<string, { readonly name: string; readonly deps: ServerDeps }>([personal, team].map(({ id, name }) => {
    const store = new VaultStore(join(root, id));
    stores.set(id, store);
    return [id, { name, deps: dependencies(store) }];
  }));
  const selections: Array<string | undefined> = [];
  const legacyStore = new NoteStore(':memory:');
  t.after(() => legacyStore.close());
  const client = await connect(t, dependencies(legacyStore), {
    list: () => Array.from(open, ([id, { name }]) => ({ id, name })),
    resolve: id => {
      selections.push(id);
      if (id === undefined) {
        const [only] = open.values();
        if (open.size === 1 && only) return only.deps;
        throw new AppError('vault_required', 'Выберите хранилище');
      }
      const entry = open.get(id);
      if (entry) return entry.deps;
      throw new AppError('vault_not_found', 'Хранилище не открыто', 404);
    }
  });
  return { client, selections, closeVault: (id: string) => {
    const store = stores.get(id);
    assert.ok(store);
    open.delete(id);
    store.close();
  } };
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;
function text(result: ToolResult): string {
  assert.ok(Array.isArray(result.content));
  const item = result.content[0];
  assert.ok(item && item.type === 'text');
  return item.text;
}

function okJson(result: ToolResult): unknown {
  assert.notEqual(result.isError, true, text(result));
  return JSON.parse(text(result));
}

test('MCP публикует список хранилищ и необязательный vault_id без выбора хранилища', async t => {
  // Arrange: открыты два хранилища.
  const { client, selections } = await vaultFixture(t);

  // Act: клиент запрашивает схемы и список хранилищ.
  const { tools } = await client.listTools();
  const result = await client.callTool({ name: 'list_vaults' });

  // Assert: только инструменты хранилища публикуют vault_id, реестр не выбирает хранилище.
  assert.equal(tools.find(tool => tool.name === 'list_vaults')?.inputSchema.properties?.vault_id, undefined);
  assert.ok(tools.some(tool => tool.name === 'add_page'));
  assert.ok(tools.some(tool => tool.name === 'get_document'));
  for (const { name, inputSchema } of tools.filter(tool => tool.name !== 'list_vaults')) {
    assert.ok(inputSchema.properties?.vault_id, name);
    assert.ok(!inputSchema.required?.includes('vault_id'), name);
  }
  assert.deepEqual(result.structuredContent, { vaults: [personal, team] });
  assert.deepEqual(okJson(result), { vaults: [personal, team] });
  assert.deepEqual(selections, []);
});

test('MCP прекращает неоднозначную запись до изменения любого хранилища', async t => {
  // Arrange: два пустых хранилища.
  const { client, selections } = await vaultFixture(t);

  // Act: клиент создаёт страницу без vault_id.
  const result = await client.callTool({ name: 'add_page', arguments: { title: 'Untargeted', path: sharedPath } });

  // Assert: MCP возвращает код выбора, обе папки остаются пустыми.
  assert.equal(result.isError, true);
  assert.match(text(result), /\[vault_required\]/);
  assert.deepEqual(selections, [undefined]);
  for (const { id } of [personal, team]) {
    assert.deepEqual(okJson(await client.callTool({ name: 'list_pages', arguments: { vault_id: id } })), []);
  }
});

test('MCP учитывает закрытие хранилища и принимает вызов без arguments при одном открытом хранилище', async t => {
  // Arrange: первый вызов явно выбирает хранилище, которое затем закрывается.
  const { client, closeVault } = await vaultFixture(t);
  okJson(await client.callTool({ name: 'add_page', arguments: { vault_id: personal.id, path: sharedPath, title: 'Kept' } }));
  okJson(await client.callTool({ name: 'list_pages', arguments: { vault_id: team.id } }));
  const ambiguous = await client.callTool({ name: 'list_pages' });
  assert.equal(ambiguous.isError, true);
  assert.match(text(ambiguous), /\[vault_required\]/);
  closeVault(team.id);

  // Act: тот же клиент обращается к закрытому ID и вызывает инструмент без аргументов.
  const closed = await client.callTool({ name: 'list_pages', arguments: { vault_id: team.id } });
  const implicit = await client.callTool({ name: 'list_pages' });

  // Assert: явный ID не заменяется оставшимся; без ID клиент получает оставшееся хранилище.
  assert.equal(closed.isError, true);
  assert.match(text(closed), /\[vault_not_found\]/);
  assert.deepEqual(pageList.parse(okJson(implicit)), [{ id: sharedPath }]);
});

test('MCP изолирует одинаковые пути и ключи повторной записи между хранилищами', async t => {
  // Arrange: обе записи используют один путь и один request_id.
  const { client, selections } = await vaultFixture(t);
  const request = { title: 'Same title', path: sharedPath, request_id: 'same-key' };
  const personalArgs = { ...request, vault_id: personal.id, source: 'Personal source' };
  const teamArgs = { ...request, vault_id: team.id, source: 'Team source' };

  // Act: клиент создаёт обе страницы и повторяет запись в личное хранилище.
  const first = okJson(await client.callTool({ name: 'add_page', arguments: personalArgs }));
  okJson(await client.callTool({ name: 'add_page', arguments: teamArgs }));
  const replay = okJson(await client.callTool({ name: 'add_page', arguments: personalArgs }));

  // Assert: каждый вызов выбирает хранилище один раз, повтор возвращает первый результат.
  assert.deepEqual(selections, [personal.id, team.id, personal.id]);
  assert.deepEqual(replay, first);
  for (const { vault_id, source } of [personalArgs, teamArgs]) {
    const result = await client.callTool({ name: 'get_document', arguments: { path: sharedPath, vault_id } });
    assert.deepEqual(documentText.parse(okJson(result)), { source });
  }
});

test('MCP без реестра сохраняет схемы и поведение SQLite', async t => {
  // Arrange: сервер работает с SQLite без реестра хранилищ.
  const store = new NoteStore(':memory:');
  t.after(() => store.close());
  const client = await connect(t, dependencies(store));

  // Act: клиент запрашивает схемы, создаёт страницу и читает список.
  const { tools } = await client.listTools();
  const added = await client.callTool({ name: 'add_page', arguments: { title: 'Legacy' } });
  const pages = await client.callTool({ name: 'list_pages' });

  // Assert: схемы и ответ не требуют выбора хранилища.
  assert.ok(tools.every(tool => tool.name !== 'list_vaults' && !tool.inputSchema.properties?.vault_id));
  const page = z.object({ page_id: z.string(), title: z.literal('Legacy'), revision: z.number() }).parse(okJson(added));
  assert.deepEqual(pageList.parse(okJson(pages)), [{ id: page.page_id }]);
});
