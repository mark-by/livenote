import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, type RunningApp } from '../src/server/app.ts';
import { NoteService } from '../src/server/services.ts';
import { VaultStore } from '../src/server/vault.ts';
import { AppError } from '../src/server/errors.ts';
import { fileVersion } from '../src/server/vaultDocument.ts';
import type { DiagramValidator, VaultDocument } from '../src/shared/types.ts';
import type { BpmnValidator } from '../src/server/validator/bpmn.ts';
import { execFileSync } from 'node:child_process';

let root: string; let running: RunningApp; let server: Server;
const base = 'http://127.0.0.1:4360';
const xml = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'vault-api-'));
  running = await createApp({ port: 4360, host: '127.0.0.1', dbPath: join(root, 'unused.sqlite'), vaultPath: join(root, 'vault'), token: null, openBrowser: false, mermaidTheme: 'default' });
  server = await new Promise<Server>((resolve, reject) => { const listener = running.app.listen(4360, '127.0.0.1', () => resolve(listener)); listener.once('error', reject); });
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await running?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
interface ResponseBody { page?: { id: string; revision: number }; document?: VaultDocument; error?: { code: string; details?: { reason?: string; currentVersion?: string } }; snapshot?: { treeVersion: string; folders: string[] }; }
async function api(path: string, method = 'GET', body?: unknown, expected = 200): Promise<ResponseBody> {
  const response = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); assert.equal(response.status, expected, text); return text ? JSON.parse(text) : {};
}
const route = (id: string) => '/pages/' + encodeURIComponent(id);
async function document(id: string): Promise<VaultDocument> { const result = await api(route(id) + '/document'); assert.ok(result.document); return result.document; }
async function create(title: string, path: string, source = '') { const result = await api('/pages', 'POST', { title, path, source }); assert.ok(result.page); return result.page; }
const tokens = (d: VaultDocument) => ({ expectedRevision: d.page.revision, expectedVersion: d.version });
async function save(d: VaultDocument, source: string) { const result = await api(route(d.path) + '/document', 'PUT', { ...tokens(d), source }); assert.ok(result.document); return result.document; }

test('native HTTP preserves plain source no-op bytes and rejects invalid changed diagrams atomically', async () => {
  const page = await create('API', 'Nested/API.md'); const before = await document(page.id);
  assert.equal(before.source, ''); assert.equal(before.page.blocks.length, 0);
  const saved = await save(before, '\uFEFF# Header\r\n\r\nprose without final newline');
  assert.equal(saved.source, '\uFEFF# Header\r\n\r\nprose without final newline');
  assert.equal((await save(saved, saved.source)).version, saved.version);
  const invalid = await api(route(page.id) + '/document', 'PUT', { ...tokens(saved), source: saved.source + '\n![x](../Invalid.drawio)', assets: [{ path: 'Invalid.drawio', source: '<mxfile>', expectedVersion: null }] }, 422);
  assert.equal(invalid.error?.code, 'diagram_invalid');
  assert.equal((await document(page.id)).version, saved.version);
  await api(route(page.id) + '/document', 'PUT', { ...tokens(saved), source: saved.source, assets: [{ path: '../escape.drawio', source: xml, expectedVersion: null }] }, 400);
  const result = await api(route(page.id) + '/document', 'PUT', { ...tokens(saved), source: saved.source + '\n![x](../Shared.drawio)', assets: [{ path: 'Shared.drawio', source: xml, expectedVersion: null }] });
  assert.ok(result.document);
  assert.equal(result.document.assets[0]?.source, xml);
  assert.equal(readFileSync(join(root, 'vault/Shared.drawio'), 'utf8'), xml);
  const prose = await save(result.document, result.document.source.replace('# Header', '# Updated'));
  writeFileSync(join(root, 'vault/Shared.drawio'), xml.replace('<mxfile>', '<mxfile modified="yes">'));
  const stale = await api(route(page.id) + '/document', 'PUT', { ...tokens(prose), source: prose.source }, 409);
  assert.equal(stale.error?.details?.reason, 'stale');
  assert.match(stale.error?.details?.currentVersion ?? '', /^sha256:/);
});

test('HTTP file moves rewrite relative incoming outgoing definitions and labels with path identity', async () => {
  const target = await create('Target', 'Docs/Target.md', '[other](../Other.md#intro) [self](#intro)\n');
  await create('Other', 'Other.md');
  const incoming = await create('Incoming', 'Refs/Incoming.md', '[one](../Docs/Target.md#x) [two][target]\n\n[target]: ../Docs/Target.md#anchor "title"\n[[../Docs/Target|wiki path]]\n');
  const before = await document(target.id);
  const response = await api(route(target.id) + '/move', 'POST', { ...tokens(before), path: 'Moved/Deep/Target.md' });
  assert.equal(response.document?.path, 'Moved/Deep/Target.md');
  assert.match(response.document?.source ?? '', /\[other\]\(\.\.\/\.\.\/Other.md#intro\)/);
  const referring = await document(incoming.id);
  assert.match(referring.source, /\.\.\/Moved\/Deep\/Target.md#x/);
  assert.match(referring.source, /\[target\]: \.\.\/Moved\/Deep\/Target.md#anchor "title"/);
  assert.match(referring.source, /\[\[\.\.\/Moved\/Deep\/Target.md\|wiki path\]\]/);
  assert.ok((await document('Moved/Deep/Target.md')).backlinks.some(link => link.path === incoming.id));
  assert.ok(response.document);
  await api(route(response.document.path) + '/move', 'POST', { ...tokens(response.document), path: 'Other.md' }, 409);
  await api(route(response.document.path) + '/move', 'POST', { ...tokens(response.document), path: '../escape.md' }, 400);
  await api(route(target.id) + '/document', 'PUT', { ...tokens(before), source: 'stale' }, 409);
});

test('native source metadata tags search and title rename retain optional user YAML', async () => {
  const target = await create('Target', 'Names/Target.md', '---\naliases: [Alias]\ncustom: 42 # keep\n---\n#ExactTag\nneedle prose');
  const incoming = await create('Incoming', 'Names/Incoming.md', '[[Alias|custom]]');
  const before = await document(target.id);
  const changed = await api(route(target.id) + '/metadata', 'PATCH', { ...tokens(before), title: 'New title' });
  assert.equal(changed.document?.path, 'Names/New title.md');
  assert.equal(changed.document?.source, before.source);
  assert.match((await document(incoming.id)).source, /\[\[New title.md\|custom\]\]/);
  const response = await fetch(base + '/api/search?q=needle&tag=ExactTag'); const result = await response.json();
  assert.equal(result.hits[0].pageId, 'Names/New title.md');
  await api('/search?q=' + 'a'.repeat(501), 'GET', undefined, 400);
});

test('actual MCP native document block and folder tools share NoteService durable replay', async () => {
  const client = new Client({ name: 'vault-api', version: '1' });
  const text = (result: Awaited<ReturnType<Client['callTool']>>): string => {
    assert.ok(Array.isArray(result.content)); const item = result.content[0];
    assert.ok(item && typeof item === 'object' && 'text' in item && typeof item.text === 'string'); return item.text;
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
    const added = await client.callTool({ name: 'add_page', arguments: { title: 'MCP', path: 'MCP/One.md', source: 'start', request_id: 'mcp-page' } });
    const page = JSON.parse(text(added)); const d = await document(page.page_id);
    const args = { path: d.path, expected_revision: d.page.revision, expected_version: d.version, source: '# MCP exact source', request_id: 'mcp-document' };
    const written = await client.callTool({ name: 'write_document', arguments: args });
    assert.notEqual(written.isError, true);
    assert.equal(text(await client.callTool({ name: 'write_document', arguments: args })), text(written));
    const current = JSON.parse(text(written));
    const inserted = await client.callTool({ name: 'write_markdown', arguments: { page_id: d.path, expected_revision: current.page.revision, expected_version: current.version, at: 0, source: 'before\n' } });
    assert.notEqual(inserted.isError, true);
    assert.equal((await document(d.path)).source, 'before\n# MCP exact source');
    const unknown = await client.callTool({ name: 'write_markdown', arguments: { page_id: d.path, block_id: 'span-999', expected_revision: (await document(d.path)).page.revision, source: 'bad' } });
    assert.equal(unknown.isError, true);
    const vault = JSON.parse(text(await client.callTool({ name: 'get_vault', arguments: {} })));
    const folder = await client.callTool({ name: 'create_folder', arguments: { path: 'MCP/Empty/Nested', expected_tree_version: vault.treeVersion } });
    assert.notEqual(folder.isError, true);
    assert.ok(JSON.parse(text(folder)).folders.includes('MCP/Empty/Nested'));
  } finally { await client.close(); }
});

function raceValidator() {
  let enter: () => void = () => {}; let release: () => void = () => {};
  const started = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const validator: DiagramValidator = { kind: 'unavailable', parse: async () => { enter(); await gate; return { syntax: 'ok', renderer: 'unavailable' }; }, render: async () => ({ validation: { syntax: 'ok', renderer: 'unavailable' } }) };
  return { validator, started, release };
}
const unusedBpmn: BpmnValidator = { kind: 'unavailable', parse: async () => ({ syntax: 'ok', renderer: 'unavailable', hasDiagram: true }), render: async () => ({ validation: { syntax: 'ok', renderer: 'unavailable' } }), layout: async source => ({ ok: true, xml: source }) };
test('validation await rejects external document edits without publishing stale content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vault-race-')); const store = new VaultStore(directory); const race = raceValidator();
  const service = new NoteService(store, { publish() {} }, race.validator, unusedBpmn, race.validator);
  try {
    const page = service.addPage('Race'); const d = store.document(page.id);
    const pending = service.writeDocument(page.id, { ...tokens(d), source: '```mermaid\nflowchart LR\n A-->B\n```' });
    await race.started; writeFileSync(join(directory, d.path), 'external'); race.release();
    await assert.rejects(pending, (error: unknown) => error instanceof AppError && error.httpStatus === 409);
    assert.equal(store.document(page.id).source, 'external');
  } finally { race.release(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('newly selected XML references recheck external bytes after validation awaits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vault-new-asset-race-')); const store = new VaultStore(directory); const race = raceValidator();
  const service = new NoteService(store, { publish() {} }, race.validator, unusedBpmn, race.validator);
  try {
    const page = service.addPage('Race'); const d = store.document(page.id); writeFileSync(join(directory, 'New.drawio'), xml);
    const pending = service.writeDocument(page.id, { ...tokens(d), source: '![x](New.drawio)', references: [{ path: 'New.drawio', expectedVersion: fileVersion(xml) }] });
    await race.started; writeFileSync(join(directory, 'New.drawio'), '<mxfile external="yes"/>'); race.release();
    await assert.rejects(pending, (error: unknown) => error instanceof AppError && error.httpStatus === 409);
    assert.equal(store.document(page.id).source, '');
  } finally { race.release(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('external reconciliation emits SSE and changed source opens without restart', async () => {
  const page = await create('External', 'External.md'); const controller = new AbortController();
  const response = await fetch(base + '/events', { signal: controller.signal }); assert.ok(response.body); const reader = response.body.getReader();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    writeFileSync(join(root, 'vault', page.id), 'updated outside'); let text = '';
    while (!text.includes('"origin":"external"') || !text.includes(page.id)) {
      const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value);
    }
    assert.match(text, /page.updated/); assert.ok(text.includes(page.id)); assert.equal((await document(page.id)).source, 'updated outside');
  } finally { clearTimeout(timeout); await reader.cancel(); controller.abort(); }
});

test('native import export and standalone diagram HTTP retain exact source and relative archive paths', async () => {
  const source = '\uFEFF# Imported\r\n\r\nwithout final newline';
  const imported = await api('/import', 'POST', { title: 'Imported', path: 'Export/Imported.md', content: source });
  assert.ok(imported.page);
  const response = await fetch(base + '/api/export/pages/' + encodeURIComponent(imported.page.id) + '.md');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(source));
  const diagram = await api('/pages', 'POST', { title: 'Standalone', path: 'Export/Standalone.drawio', format: 'drawio', source: xml });
  assert.ok(diagram.page);
  const d = await document(diagram.page.id);
  assert.equal(d.page.blocks[0]?.source, xml); assert.deepEqual(d.assets, []);
  assert.equal((await save(d, d.source)).version, d.version);
  await api('/pages', 'POST', { title: 'Invalid', path: 'Export/Invalid.md', source: '```drawio\n<mxfile>\n```' });
  await api('/pages', 'POST', { title: 'Invalid inline', path: 'Export/Invalid-inline.md', source: '![x](Missing.drawio)' }, 422);
  const zip = await fetch(base + '/api/export/all.zip'); assert.equal(zip.headers.get('content-type'), 'application/zip');
  const archive = join(root, 'export.zip'); writeFileSync(archive, Buffer.from(await zip.arrayBuffer()));
  execFileSync('/usr/bin/unzip', ['-t', archive]);
  assert.deepEqual(execFileSync('/usr/bin/unzip', ['-p', archive, 'Export/Imported.md']), Buffer.from(source));
  assert.deepEqual(execFileSync('/usr/bin/unzip', ['-p', archive, 'Export/Standalone.drawio']), Buffer.from(xml));
});
