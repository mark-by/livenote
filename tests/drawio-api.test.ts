import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, type RunningApp } from '../src/server/app.ts';
import { exportPageMarkdown } from '../src/server/export.ts';
import { parseMarkdownToBlocks } from '../src/server/import.ts';

const VALID_DRAWIO =
  '<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
const INVALID_DRAWIO = '<mxfile><diagram></mxfile>';

let running: RunningApp;
let server: Server;
let baseUrl: string;
let temporaryDirectory: string;

before(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'livenote-drawio-api-'));
  const port = await availablePort();
  running = await createApp({
    port,
    host: '127.0.0.1',
    dbPath: join(temporaryDirectory, 'notes.db'),
    token: null,
    openBrowser: false,
    mermaidTheme: 'default'
  });
  server = await new Promise<Server>((resolve) => {
    const listener = running.app.listen(port, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
  const validators = running.service as unknown as {
    validator: { browser?: { close(): Promise<void> } };
    bpmnValidator: { browser?: { close(): Promise<void> } };
  };
  await validators.validator.browser?.close();
  await validators.bpmnValidator.browser?.close();
  running.store.close();
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('drawio сохраняется, а ошибочный XML не меняет revision', async () => {
  const page = running.service.addPage('Draw.io persistence');
  const written = await running.service.writeBlock(page.id, 'architecture', 'drawio', VALID_DRAWIO, page.revision);
  assert.equal(written.validation?.syntax, 'ok');
  assert.equal(written.revision, page.revision + 1);
  const saved = running.service.getPage(page.id);
  assert.equal(saved.blocks[0]?.type, 'drawio');
  assert.equal(saved.blocks[0]?.source, VALID_DRAWIO);

  const rejected = await running.service.writeBlock(
    page.id,
    'architecture',
    'drawio',
    INVALID_DRAWIO,
    saved.revision
  );
  assert.equal(rejected.validation?.syntax, 'error');
  assert.equal(rejected.revision, saved.revision);
  assert.equal(running.service.getPage(page.id).blocks[0]?.source, VALID_DRAWIO);

  const checked = await running.service.checkDiagram(page.id, 'architecture', { mode: 'syntax' });
  assert.equal(checked.validation.syntax, 'ok');
});

test('REST создаёт drawio и возвращает ошибку валидации без записи', async () => {
  const created = await api('/api/pages', { title: 'Draw.io REST' });
  const page = created.page;
  const written = await api(`/api/pages/${page.id}/blocks`, {
    blockId: 'rest-drawio',
    type: 'drawio',
    source: VALID_DRAWIO,
    expectedRevision: page.revision
  });
  assert.equal(written.page.blocks[0].type, 'drawio');
  assert.equal(written.validation.syntax, 'ok');

  const rejected = await api(`/api/pages/${page.id}/blocks/rest-drawio`, {
    source: INVALID_DRAWIO,
    expectedRevision: written.page.revision
  }, 'PUT');
  assert.equal(rejected.validation.syntax, 'error');
  assert.equal(rejected.page.revision, written.page.revision);
  assert.equal(rejected.page.blocks[0].source, VALID_DRAWIO);
});

test('MCP write_diagram принимает format=drawio', async () => {
  const client = new Client({ name: 'drawio-api-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  try {
    await client.connect(transport);
    const added = await client.callTool({ name: 'add_page', arguments: { title: 'Draw.io MCP' } });
    const page = toolJson(added);
    const written = await client.callTool({
      name: 'write_diagram',
      arguments: {
        page_id: page.page_id,
        block_id: 'mcp-drawio',
        expected_revision: page.revision,
        format: 'drawio',
        source: VALID_DRAWIO
      }
    });
    const result = toolJson(written);
    assert.equal(result.validation.syntax, 'ok');
    assert.equal(running.service.getPage(page.page_id).blocks[0]?.type, 'drawio');
  } finally {
    await client.close();
  }
});

test('Markdown export/import сохраняет drawio и название', async () => {
  const page = running.service.addPage('Draw.io Markdown');
  await running.service.writeBlock(page.id, 'markdown-diagram', 'drawio', VALID_DRAWIO, page.revision, undefined, {
    title: 'System overview'
  });
  const markdown = exportPageMarkdown(running.service.getPage(page.id));
  assert.match(markdown, /```drawio title="System overview"/);
  const parsed = parseMarkdownToBlocks(markdown);
  assert.equal(parsed.blocks[0]?.type, 'drawio');
  assert.equal(parsed.blocks[0]?.source, VALID_DRAWIO);
  assert.equal(parsed.blocks[0]?.title, 'System overview');
});

test('/drawio отдаёт локальную статику, CSP и 404 для отсутствующего asset', async () => {
  const index = await fetch(`${baseUrl}/drawio/index.html`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<html/i);
  const csp = index.headers.get('content-security-policy') ?? '';
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /font-src 'self' data:/);
  assert.match(csp, /frame-src 'self' blob:/);

  const missing = await fetch(`${baseUrl}/drawio/definitely-missing-drawio-asset.js`);
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /<html/i);
});

async function api(path: string, body: unknown, method = 'POST'): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

function toolJson(result: any): any {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}
