import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { applyFlowchartEdit as edit } from '../src/web/flowchart/index.ts';

test('Mermaid принимает изменённые подписи, цепочки, подграфы и ненаправленные связи', async () => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1' },
    plugins: [{
      name: 'flowchart-validation',
      configureServer(vite) {
        vite.middlewares.use('/flowchart-validation', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html><body></body></html>');
        });
      },
    }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/flowchart-validation`);
    const label = 'First line\nSecond "quoted" #quot; #35; | end';
    const source = `flowchart TD
subgraph group
  A[Alpha] --> B{Beta} --> C((Gamma))
end
class A,B hot
classDef hot fill:red
linkStyle 0,1 stroke:red
`;
    const cases = [
      edit(source, { type: 'renameNode', id: 'A', label }),
      edit(source, { type: 'updateEdgeLabel', id: 'edge-0', label }),
      edit(source, { type: 'addNode', id: 'Added', label }),
      edit(source, { type: 'addEdge', from: 'A', to: 'C', label }),
      edit(source, { type: 'removeNode', id: 'B' }),
      edit(source, { type: 'removeEdge', id: 'edge-0' }),
      edit('flowchart LR\nA --- B', { type: 'updateEdgeLabel', id: 'edge-0', label }),
      edit('flowchart LR; A[Alpha] --> B[Beta]', { type: 'removeEdge', id: 'edge-0' }),
    ];
    await page.evaluate(async (sources) => {
      const modulePath = '/node_modules/mermaid/dist/mermaid.esm.min.mjs';
      const { default: mermaid } = await import(/* @vite-ignore */ modulePath);
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      for (const source of sources) await mermaid.parse(source);
    }, cases);
  } finally {
    await browser?.close();
    await server.close();
  }
});
