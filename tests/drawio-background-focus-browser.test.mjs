import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, expect } from 'playwright/test';

const project = fileURLToPath(new URL('../', import.meta.url));
let directory;
let server;
let browser;
let base;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'livenote-drawio-focus-'));
  await writeFile(join(directory, 'index.html'), '<html lang="ru"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await writeFile(join(directory, 'fixture.tsx'), `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DiagramPreview } from ${JSON.stringify(join(project, 'src/web/diagrams/DiagramPreview.tsx'))};
import { DiagramDialog } from ${JSON.stringify(join(project, 'src/web/diagrams/DiagramDialog.tsx'))};
import { LivePreviewEditor } from ${JSON.stringify(join(project, 'src/web/editor/LivePreviewEditor.tsx'))};
import ${JSON.stringify(join(project, 'src/web/heroui.css'))};
import ${JSON.stringify(join(project, 'src/web/styles.css'))};
const xml='<mxfile><diagram name="Схема"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
function Fixture() {
  const [active,setActive]=useState(false);
  const [source,setSource]=useState('');
  const [editing,setEditing]=useState(false);
  return <main>
    <button onClick={()=>setActive(true)}>Открыть заметку</button>
    <article hidden={active}><DiagramPreview value={{format:'drawio',source:xml}} onEdit={()=>setEditing(true)} onExpand={()=>setEditing(true)}/></article>
    <article hidden={!active}><LivePreviewEditor source={source} onChange={setSource} renderDiagram={()=>null} vimEnabled={false}/></article>
    {editing && <DiagramDialog session={{value:{format:'drawio',source:xml},mode:'edit',key:'edit'}} onSave={async()=>{}} onCancel={()=>setEditing(false)}/>}
    <output data-source>{source}</output>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  server = await createServer({
    configFile: false, root: directory, cacheDir: join(directory, 'cache'),
    publicDir: join(project, 'src/web/public'), plugins: [tailwindcss()],
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { react: join(project, 'node_modules/react'), 'react-dom': join(project, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [project, directory] } }
  });
  await server.listen();
  base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

test('Визуальный редактор draw.io принимает фокус и ввод', { timeout: 45_000 }, async t => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(base);
  await expect(page.locator('.drawio-preview__image')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Редактировать диаграмму' }).click();
  const frame = page.locator('.drawio-fullscreen__frame').contentFrame();
  const canvas = frame.locator('.geDiagramContainer');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await canvas.dblclick({ position: { x: 500, y: 400 } });
  await canvas.getByText('Text', { exact: true }).last().dblclick();
  const cell = frame.locator('.mxCellEditor[contenteditable="true"]:visible');
  await expect(cell).toBeFocused();
  await page.keyboard.type('Проверка');
  await expect(cell).toContainText('Проверка');
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('Загрузка скрытого draw.io не отнимает фокус редактора заметки', { timeout: 45_000 }, async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  let releaseFrame;
  const frameGate = new Promise(resolve => { releaseFrame = resolve; });
  let notifyFrame;
  const frameStarted = new Promise(resolve => { notifyFrame = resolve; });
  await page.route('**/drawio/index.html?*', async route => {
    notifyFrame();
    await frameGate;
    await route.continue();
  });
  t.after(() => releaseFrame());
  await page.goto(base);
  await frameStarted;
  await page.getByRole('button', { name: 'Открыть заметку' }).click();
  const editor = page.getByRole('textbox', { name: 'Текст заметки' });
  await editor.click();
  await page.keyboard.type('ALPHA');
  releaseFrame();
  await expect(page.locator('article[hidden] .drawio-preview__image')).toHaveCount(1, { timeout: 30_000 });
  await expect(editor).toBeFocused();
  await page.keyboard.type(' BETA');
  assert.equal(await page.locator('[data-source]').textContent(), 'ALPHA BETA');
});
