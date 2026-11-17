import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, expect } from 'playwright/test';

const project = fileURLToPath(new URL('../', import.meta.url));
const timeout = 45_000;
const screenshots = process.env.LIVENOTE_DIAGRAM_SCREENSHOTS;
let directory;
let server;
let browser;
let base;

before(async () => {
  if (screenshots) await mkdir(screenshots, { recursive: true });
  directory = await mkdtemp(join(tmpdir(), 'livenote-diagram-context-'));
  await writeFile(join(directory, 'index.html'), '<html lang="ru"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await writeFile(join(directory, 'fixture.tsx'), `
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LivePreviewEditor} from ${JSON.stringify(join(project, 'src/web/editor/LivePreviewEditor.tsx'))};
import {DiagramPreview} from ${JSON.stringify(join(project, 'src/web/diagrams/DiagramPreview.tsx'))};
import {VaultDocumentView} from ${JSON.stringify(join(project, 'src/web/vault/VaultDocumentView.tsx'))};
import ${JSON.stringify(join(project, 'src/web/heroui.css'))};
import ${JSON.stringify(join(project, 'src/web/vault.css'))};
const renderDiagram=diagram=><button>Схема {diagram.format}</button>;
const sources={
  mermaid:'flowchart LR\\n  A[Начало] --> B[Конец]',
  bpmn:'<b:definitions xmlns:b="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:d="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:c="http://www.omg.org/spec/DD/20100524/DC" targetNamespace="urn:fixture"><b:process id="P"><b:startEvent id="S"/></b:process><d:BPMNDiagram id="D"><d:BPMNPlane id="Plane" bpmnElement="P"><d:BPMNShape id="Shape" bpmnElement="S"><c:Bounds x="200" y="120" width="36" height="36"/></d:BPMNShape></d:BPMNPlane></d:BPMNDiagram></b:definitions>',
  drawio:'<mxfile><diagram name="Схема"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'
};
function Fixture() {
  const [source,setSource]=useState(new URLSearchParams(location.search).get('source')??'');
  const [vimEnabled,setVim]=useState(false);
  const [context,setContext]=useState(null);
  const [removed,setRemoved]=useState(0);
  const format=new URLSearchParams(location.search).get('format');
  if (location.search.includes('shell=1')) {
    const document={path:'Тест.md',source,page:{title:'Тест',revision:0},spans:[],assets:[],tags:[],backlinks:[]};
    const workspace={drafts:{'Тест.md':{source,epoch:0}},snapshot:{files:[]},changeDraft:(_,next)=>setSource(next)};
    return <VaultDocumentView workspace={workspace} document={document} active theme="light" vimEnabled={true} onVimModeChange={()=>{}}/>;
  }
  if (format) return <main><DiagramPreview value={{format,source:sources[format],title:'Тестовая схема'}}
    onEdit={()=>{}} onExpand={()=>{}} {...(location.search.includes('removable=1') ? {onRemove:()=>setRemoved(value=>value+1)} : {})}/>
    <output data-removed>{removed}</output></main>;
  return <main><button onClick={()=>setVim(value=>!value)}>Vim</button>
    <LivePreviewEditor source={source} onChange={setSource} renderDiagram={renderDiagram}
      vimEnabled={vimEnabled} onContextMenu={setContext}/>
    <output hidden data-context>{JSON.stringify(context)}</output>
    <output hidden data-source>{source}</output></main>;
}

createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  server = await createServer({
    configFile: false, root: directory, cacheDir: join(directory, 'cache'), publicDir: join(project, 'src/web/public'),
    plugins: [tailwindcss()], esbuild: { jsx: 'automatic' },
    resolve: { alias: { react: join(project, 'node_modules/react'), 'react-dom': join(project, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [project, directory] } }
  });
  await server.listen();
  base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('Контекстное меню оболочки открывается после Cmd+A в Vim', { timeout }, async t => {
  const source = 'Начало текста\n\nКонец текста';
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(`${base}?shell=1&source=${encodeURIComponent(source)}`);
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.focus();
  await page.keyboard.press('Meta+a');
  await editor.click({ button: 'right', position: { x: 10, y: 10 } });
  await expect(page.getByRole('menuitem', { name: 'Вставить диаграмму' })).toBeVisible();
});

for (const format of ['mermaid', 'bpmn', 'drawio']) {
  test(`Кнопка удаления ${format} вызывает только callback`, { timeout }, async t => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}?format=${format}&removable=1`);
    const remove = page.getByRole('button', { name: 'Удалить диаграмму' });
    await expect(remove).toBeVisible();
    if (screenshots) {
      if (format === 'mermaid') await expect(page.locator('.mermaid-block svg.flowchart')).toBeVisible();
      if (format === 'bpmn') await expect(page.locator('.bpmn-block .djs-container')).toBeVisible();
      if (format === 'drawio') await expect(page.locator('.drawio-preview__image')).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: join(screenshots, `${format}-mobile.png`) });
    }
    await remove.click();
    await expect(page.locator('[data-removed]')).toHaveText('1');
    await expect(page.getByRole('button', { name: 'Редактировать диаграмму' })).toBeVisible();
  });

  test(`Диаграмма ${format} без callback не предлагает удаление`, { timeout }, async t => {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}?format=${format}`);
    await expect(page.getByRole('button', { name: 'Редактировать диаграмму' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Удалить диаграмму' })).toHaveCount(0);
  });
}

test('Правый клик после Cmd+A в Vim передаёт контекст текста', { timeout }, async t => {
  const source = 'Начало текста\n\nКонец текста';
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(`${base}?source=${encodeURIComponent(source)}`);
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await page.getByRole('button', { name: 'Vim' }).click();
  await editor.focus();
  await page.keyboard.press('Meta+a');
  await editor.click({ button: 'right', position: { x: 10, y: 10 } });
  await expect(page.locator('[data-context]')).not.toHaveText('null');
  const result = JSON.parse(await page.locator('[data-context]').textContent());
  assert.equal(result.from, result.to);
  assert.equal(result.diagram, undefined);
  assert.equal(await page.locator('[data-source]').textContent(), source);
});

for (const vim of [false, true]) {
  test(`Правый клик по тексту передаёт позицию при Vim ${vim}`, { timeout }, async t => {
    const source = 'Начало текста\n\nКонец текста';
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}?source=${encodeURIComponent(source)}`);
    const editor = page.getByRole('textbox', { name: 'Текст заметки' });
    await expect(editor).toBeVisible();
    if (vim) {
      await page.getByRole('button', { name: 'Vim' }).click();
      await editor.focus();
      await page.keyboard.press('v');
      await expect(page.getByRole('status')).toHaveText('Vim · Visual');
    }
    await page.locator('.cm-line').last().click({ button: 'right' });
    await expect(page.locator('[data-context]')).not.toHaveText('null');
    const result = JSON.parse(await page.locator('[data-context]').textContent());
    assert.equal(result.from, result.to);
    assert.ok(result.from >= source.indexOf('Конец'));
    assert.equal(result.diagram, undefined);
    assert.equal(await page.locator('[data-source]').textContent(), source);
  });

  test(`Правый клик по схеме передаёт её диапазон при Vim ${vim}`, { timeout }, async t => {
    const token = '![Процесс](./Процесс.bpmn)';
    const source = `До\n\n${token}\n\nПосле`;
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}?source=${encodeURIComponent(source)}`);
    await expect(page.getByRole('button', { name: 'Схема bpmn' })).toBeVisible();
    if (vim) {
      await page.getByRole('button', { name: 'Vim' }).click();
      await page.getByRole('textbox').focus();
      await page.keyboard.press('v');
      await expect(page.getByRole('status')).toHaveText('Vim · Visual');
    }
    await page.getByRole('button', { name: 'Схема bpmn' }).click({ button: 'right' });
    await expect(page.locator('[data-context]')).not.toHaveText('null');
    const result = JSON.parse(await page.locator('[data-context]').textContent());
    assert.deepEqual({ from: result.from, to: result.to, diagram: result.diagram }, {
      from: 4, to: 4 + token.length,
      diagram: { from: 4, to: 4 + token.length, format: 'bpmn', source: '', target: './Процесс.bpmn', label: 'Процесс' }
    });
    assert.equal(await page.locator('[data-source]').textContent(), source);
  });
}
