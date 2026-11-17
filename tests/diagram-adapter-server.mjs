import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createApp } from '../src/server/app.ts';

const temp = await mkdtemp(join(tmpdir(), 'livenote-diagrams-4362-'));
const port = 4362;
const running = await createApp({
  host: '127.0.0.1', port, dbPath: join(temp, 'test.sqlite'), token: null, mermaidTheme: 'default'
});
const vite = await createViteServer({
  configFile: false, root: join(process.cwd(), 'src/web'), plugins: [react(), tailwindcss()],
  cacheDir: join(temp, 'vite'), server: { middlewareMode: true, hmr: false, fs: { allow: [process.cwd(), temp] } }
});
const server = createHttpServer(async (req, res) => {
  const pathname = (req.url ?? '').split('?')[0];
  if (pathname === '/diagram-adapter-harness') {
    const html = await vite.transformIndexHtml('/diagram-adapter-harness',
      '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверка диаграммы</title></head><body><div id="root"></div><script type="module" src="/@fs/' +
      join(process.cwd(), 'tests/diagram-adapter-harness.tsx') + '"></script></body></html>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  } else if (/^\/(?:api|events|mcp|drawio)(?:\/|$)/.test(pathname)) {
    running.app(req, res);
  } else {
    vite.middlewares(req, res);
  }
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await vite.close();
  await running.close();
  await rm(temp, { recursive: true, force: true });
  console.log(`CLEANUP ${temp} server=${port} closed`);
}
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
server.listen(port, '127.0.0.1', () => console.log(`READY http://127.0.0.1:${port} temp=${temp}`));
