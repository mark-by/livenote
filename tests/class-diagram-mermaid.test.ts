import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { applyClassDiagramEdit as edit } from '../src/web/classDiagram/index.ts';

test('Mermaid принимает изменения диаграммы классов', async () => {
  const server = await createServer({
    configFile: false, root: process.cwd(), logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1' },
    plugins: [{ name: 'class-validation', configureServer(vite) {
      vite.middlewares.use('/class-validation', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/class-validation`);
    const source = 'classDiagram\ndirection BT\nclass cells {\n bigint cell_type_id\n boolean closed_for_placing\n}\nclass racks {\n bigint rack_id\n}\ncells "1" --> "*" racks : contains\n';
    const cases = [
      edit(source, { type: 'renameNode', id: 'cells', label: 'Cell' }),
      edit(source, { type: 'addNode', id: 'newClass', label: 'New class' }),
      edit(source, { type: 'updateMembers', id: 'cells', members: ['+open()', 'int count'] }),
      edit(source, { type: 'addEdge', from: 'racks', to: 'cells', relation: '<|--', label: 'new' }),
      edit(source, { type: 'updateEdgeLabel', id: 'edge-0', label: 'updated' }),
      edit(source, { type: 'updateRelation', id: 'edge-0', relation: '*--' }),
      edit(source, { type: 'removeEdge', id: 'edge-0' }),
      edit(source, { type: 'removeNode', id: 'cells' }),
    ];
    await page.evaluate(async (sources) => {
      const modulePath = '/node_modules/mermaid/dist/mermaid.esm.min.mjs';
      const { default: mermaid } = await import(/* @vite-ignore */ modulePath);
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      for (const text of sources) await mermaid.parse(text);
    }, cases);
  } finally {
    await browser?.close();
    await server.close();
  }
});
