import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from 'playwright/test';
import { createServer } from 'vite';

const timeout = 45_000;
const project = fileURLToPath(new URL('../', import.meta.url));
const source = 'flowchart TB\n  A[Исходная схема] --> B';
const pageId = 'saved-page';
const blockId = 'saved-block';
const initialRevision = 4;
const savedRevision = 5;
const svgSelector = '.mermaid-block > div:not([class]) > svg';
let directory;
let server;
let browser;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'livenote-mermaid-metadata-'));
  await writeFile(join(directory, 'index.html'), '<meta charset="UTF-8"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
  const modulePath = file => JSON.stringify(join(project, 'src/web', file));
  await writeFile(join(directory, 'fixture.tsx'), `
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MermaidBlockView } from ${modulePath('components/MermaidBlockView.tsx')};
import { setThemeOverride } from ${modulePath('mermaidInit.ts')};
function Fixture() {
  const [props, setProps] = useState({
    block: {
      source: ${JSON.stringify(source)}, title: null,
      pageId: ${JSON.stringify(pageId)}, id: ${JSON.stringify(blockId)},
      renderOk: null, renderedRevision: null,
    },
    pageRevision: ${initialRevision}, persisted: true,
  });
  window.updatePreview = ({ block, ...patch }) => flushSync(() => {
    setProps(current => ({ ...current, ...patch, block: { ...current.block, ...block } }));
  });
  window.changeTheme = () => setThemeOverride('dark');
  return <MermaidBlockView {...props} />;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`);
  const aliases = ['react', 'react-dom'].map(name => [name, join(project, 'node_modules', name)]);
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: join(directory, 'cache'),
    esbuild: { jsx: 'automatic' },
    resolve: { alias: Object.fromEntries(aliases) },
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [project, directory] } }
  });
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function openPreview(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const confirmations = [];
  await page.route('**/api/config', route => route.fulfill({ json: { mermaidTheme: 'default' } }));
  await page.route('**/api/pages/*/blocks/*/rendered', route => {
    const request = route.request();
    confirmations.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    return route.fulfill({ status: 204 });
  });
  await page.goto(server.resolvedUrls.local[0]);
  const svg = page.locator(svgSelector);
  await expect(svg).toContainText('Исходная схема');
  await expect.poll(() => confirmations).toEqual([confirmation(initialRevision, true)]);
  return { page, svg, confirmations };
}

function confirmation(revision, ok) {
  return { path: `/api/pages/${pageId}/blocks/${blockId}/rendered`, body: { revision, ok } };
}

test('Черновик и автосохранение сохраняют узел Mermaid SVG и подтверждают сохранённую ревизию', { timeout }, async t => {
  // Arrange: запоминаем узел подтверждённой диаграммы.
  const { page, svg, confirmations } = await openPreview(t);
  const original = await svg.elementHandle();

  // Act: правка текста переводит блок в черновик, автосохранение возвращает ID и обновляет ревизию.
  await page.evaluate(() => window.updatePreview({
    persisted: false, pageRevision: 0, block: { id: 'draft-block', pageId: '', title: 'Черновик' }
  }));
  const sameDuringDraft = await svg.evaluate((node, previous) => node === previous, original);
  await page.evaluate(metadata => window.updatePreview(metadata), {
    persisted: true, pageRevision: savedRevision, block: { id: blockId, pageId, title: 'Сохранено' }
  });

  // Assert: оба перехода сохраняют тот же узел, а черновик не отправляет подтверждение.
  await expect.poll(() => confirmations).toEqual([confirmation(initialRevision, true), confirmation(savedRevision, true)]);
  assert.equal(sameDuringDraft, true, 'Правка текста заменила узел SVG');
  assert.equal(await svg.evaluate((node, previous) => node === previous, original), true, 'Автосохранение заменило узел SVG');
});

test('Ошибка нового исходника сохраняет старый SVG и подтверждается после сохранения', { timeout }, async t => {
  // Arrange: запоминаем подтверждённый SVG.
  const { page, svg, confirmations } = await openPreview(t);
  const original = await svg.elementHandle();
  const invalidSource = 'not a mermaid diagram';

  // Act: меняем исходник черновика и сохраняем его после ошибки Mermaid.
  await page.evaluate(source => window.updatePreview({
    persisted: false, block: { source }
  }), invalidSource);
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await page.evaluate(pageRevision => window.updatePreview({ persisted: true, pageRevision }), savedRevision);

  // Assert: сохранённая ревизия получает ошибку, несмотря на видимый SVG прошлой версии.
  const expected = confirmation(savedRevision, false);
  expected.body.error = expect.stringContaining(invalidSource);
  await expect.poll(() => confirmations).toEqual([confirmation(initialRevision, true), expected]);
  assert.match(await alert.textContent(), /not a mermaid diagram/);
  assert.equal(await svg.evaluate((node, previous) => node === previous, original), true);
});

test('При смене исходника Mermaid подтверждает ревизию после замены видимого SVG', { timeout }, async t => {
  // Arrange: запоминаем SVG исходной версии.
  const { page, svg, confirmations } = await openPreview(t);
  const original = await svg.elementHandle();
  const nextSource = 'flowchart LR\n  C[Новая схема] --> D';
  await page.evaluate(selector => {
    const fetch = window.fetch.bind(window);
    window.visibleAtConfirmation = [];
    window.fetch = (url, options) => {
      if (typeof url === 'string' && url.endsWith('/rendered')) {
        window.visibleAtConfirmation.push(document.querySelector(selector)?.textContent);
      }
      return fetch(url, options);
    };
  }, svgSelector);

  // Act: меняем исходник сохранённой версии.
  await page.evaluate(({ source, pageRevision }) => window.updatePreview({ pageRevision, block: { source } }), {
    source: nextSource, pageRevision: savedRevision,
  });

  // Assert: запрос подтверждения видит новую схему уже в момент отправки.
  await expect.poll(() => confirmations).toEqual([confirmation(initialRevision, true), confirmation(savedRevision, true)]);
  assert.deepEqual(await page.evaluate(() => window.visibleAtConfirmation.map(text => text?.includes('Новая схема'))), [true]);
  assert.equal(await svg.evaluate((node, previous) => node === previous, original), false);
});

test('Новая тема Mermaid заменяет видимый SVG при неизменном исходнике', { timeout }, async t => {
  // Arrange: запоминаем SVG исходной темы.
  const { page, svg, confirmations } = await openPreview(t);
  const original = await svg.elementHandle();

  // Act: меняем только тему.
  await page.evaluate(() => window.changeTheme());

  // Assert: новый SVG содержит ту же схему и подтверждает ту же ревизию.
  await expect.poll(() => confirmations).toEqual([confirmation(initialRevision, true), confirmation(initialRevision, true)]);
  assert.equal(await svg.evaluate((node, previous) => node === previous, original), false);
  await expect(svg).toContainText('Исходная схема');
});
