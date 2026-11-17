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
const timeout = 45_000;
let directory;
let server;
let browser;
let base;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'livenote-editor-test-'));
  await writeFile(join(directory, 'index.html'), '<html lang="ru"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await writeFile(join(directory, 'fixture.tsx'), `
import {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LivePreviewEditor} from ${JSON.stringify(join(project, 'src/web/editor/LivePreviewEditor.tsx'))};
import ${JSON.stringify(join(project, 'src/web/heroui.css'))};
function Diagram({diagram}) {
  const [edits,setEdits]=useState(0);
  return <button onClick={()=>setEdits(value=>value+1)}>Схема {diagram.format}: {edits}</button>;
}
const renderDiagram=diagram=><Diagram diagram={diagram}/>;
function Fixture() {
  const [source,setSource]=useState(new URLSearchParams(location.search).get('source')??'');
  const [vimEnabled,setVim]=useState(false);
  const [opened,setOpened]=useState([]);
  const [selection,setSelection]=useState({from:0,to:0});
  const [context,setContext]=useState(null);
  const editor=useRef(null);
  return <main style={{height:'90vh'}}>
    <button onClick={()=>setVim(value=>!value)} aria-pressed={vimEnabled}>Vim</button>
    <LivePreviewEditor ref={editor} source={source} onChange={setSource}
      renderDiagram={renderDiagram} vimEnabled={vimEnabled}
      onOpenLink={target=>setOpened(value=>[...value,target])} onSelectionChange={setSelection}
      onContextMenu={setContext}/>
    <output hidden data-source>{source}</output>
    <output hidden data-opened>{JSON.stringify(opened)}</output>
    <output hidden data-selection>{JSON.stringify(selection)}</output>
    <output hidden data-context>{JSON.stringify(context)}</output>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: join(directory, 'cache'),
    plugins: [tailwindcss()],
    esbuild: { jsx: 'automatic' },
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

async function fixture(t, source) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(`${base}?source=${encodeURIComponent(source)}`);
  await expect(page.getByRole('textbox', { name: 'Текст заметки' })).toBeVisible();
  return page;
}

test('Обычный клик редактирует ссылку, Cmd-клик и Cmd-Enter вызывают открытие цели', { timeout }, async t => {
  const page = await fixture(t, '[Документ](./Другой.md) и [[Работа/План.md|План]]');
  const document = page.locator('.lp-link').filter({ hasText: 'Документ' });

  await document.click();
  await expect(page.locator('[data-opened]')).toHaveText('[]');
  await expect(page.getByRole('textbox')).toContainText('[Документ](./Другой.md)');
  await document.click({ modifiers: ['Meta'] });

  await expect(page.locator('[data-opened]')).toHaveText('["./Другой.md"]');
  const wiki = page.locator('.lp-link').filter({ hasText: 'План' });
  await wiki.click();
  await page.keyboard.press('Meta+Enter');
  await expect(page.locator('[data-opened]')).toHaveText('["./Другой.md","Работа/План.md"]');
});

test('Списки и цитаты оформлены, маркеры раскрываются только в активной строке', { timeout }, async t => {
  const page = await fixture(t, '- Один\n- Два\n\n> Цитата');
  const editor = page.getByRole('textbox');
  await expect(editor).toContainText('• Два');
  await expect(page.locator('.lp-quote')).toHaveText('Цитата');

  await page.locator('.lp-quote').click();

  await expect(page.locator('.lp-quote')).toHaveText('> Цитата');
  await expect(editor).toContainText('• Один');
  assert.equal(await page.locator('.lp-quote').evaluate(element => getComputedStyle(element).borderInlineStartWidth), '1px');
});

test('Два одинаковых inline embeds сохраняют прозу, отдельные controls и атомарный selection', { timeout }, async t => {
  const token = '![A](./a.bpmn)';
  const source = `До ${token} между ${token} после.`;
  const page = await fixture(t, source);
  await expect(page.getByRole('button', { name: 'Схема bpmn: 0', exact: true })).toHaveCount(2);
  await expect(page.getByRole('textbox')).toContainText('До ');
  await expect(page.getByRole('textbox')).toContainText(' между ');
  await expect(page.getByRole('textbox')).toContainText(' после.');

  await page.getByRole('button', { name: 'Схема bpmn: 0', exact: true }).first().click();
  const editor = page.getByRole('textbox');
  await editor.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');

  await expect(page.locator('[data-selection]')).toHaveText(JSON.stringify({ from: 3 + token.length, to: 3 + token.length }));
  await expect(page.getByRole('button', { name: 'Схема bpmn: 1', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Схема bpmn: 0', exact: true })).toHaveCount(1);
  await expect(page.locator('[data-source]')).toHaveText(source);
});

test('Правый клик по controls встроенной схемы передаёт её точный source range', { timeout }, async t => {
  const token = '![Процесс](./Процесс.bpmn)';
  const source = `До\n\n${token}\n\nПосле`;
  const page = await fixture(t, source);

  await page.getByRole('button', { name: 'Схема bpmn: 0', exact: true }).click({ button: 'right' });

  await expect(page.locator('[data-context]')).not.toHaveText('null');
  const context = JSON.parse(await page.locator('[data-context]').textContent());
  assert.deepEqual({ from: context.from, to: context.to, diagram: context.diagram }, {
    from: 4, to: 4 + token.length,
    diagram: { from: 4, to: 4 + token.length, format: 'bpmn', source: '', target: './Процесс.bpmn', label: 'Процесс' }
  });
});

test('Переключение Vim сохраняет текст, selection и обычную историю отмены', { timeout }, async t => {
  const source = '# Заголовок\n\nТекст';
  const page = await fixture(t, source);
  const editor = page.getByRole('textbox');
  await editor.focus();
  await page.keyboard.insertText('Новый ');
  const edited = await page.locator('[data-source]').textContent();
  const selection = await page.locator('[data-selection]').textContent();

  await page.getByRole('button', { name: 'Vim', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Vim · Normal');
  await expect(page.locator('[data-selection]')).toHaveText(selection);
  await expect(page.locator('[data-source]')).toHaveText(edited);
  await editor.focus();
  await page.keyboard.press('i');
  await expect(page.getByRole('status')).toHaveText('Vim · Insert');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Vim', exact: true }).click();
  await editor.focus();
  await page.keyboard.press('Meta+z');

  await expect(page.locator('[data-source]')).toHaveText(source);
});
