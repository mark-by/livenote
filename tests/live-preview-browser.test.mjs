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
  const [source,setSource]=useState(window.initialSource);
  const [vimEnabled,setVim]=useState(false);
  const [vimMode,setVimMode]=useState('normal');
  const [opened,setOpened]=useState([]);
  const [selection,setSelection]=useState({from:0,to:0});
  const [context,setContext]=useState(null);
  const [readOnly,setReadOnly]=useState(false);
  const editor=useRef(null);
  return <main style={{height:'90vh'}}>
    <button onClick={()=>setVim(value=>!value)} aria-pressed={vimEnabled}>Vim</button>
    <button onClick={()=>setReadOnly(value=>!value)} aria-pressed={readOnly}>Только чтение</button>
    <LivePreviewEditor ref={editor} source={source} onChange={setSource}
      renderDiagram={renderDiagram} vimEnabled={vimEnabled} onVimModeChange={setVimMode} readOnly={readOnly}
      onOpenLink={target=>setOpened(value=>[...value,target])} onSelectionChange={setSelection}
      onContextMenu={setContext}/>
    {vimEnabled && <output>Vim · {vimMode[0].toUpperCase() + vimMode.slice(1)}</output>}
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
  await page.addInitScript(value => { window.initialSource = value; }, source);
  await page.goto(base);
  await expect(page.getByRole('textbox', { name: 'Текст заметки' })).toBeVisible();
  return page;
}

test('Markdown-таблица отображается как таблица, если курсор вне неё', { timeout }, async t => {
  const source = 'Вступление\n\n| Сценарий | Данные |\n| --- | --- |\n| Расчёт | `mid` |';
  const page = await fixture(t, source);

  await expect(page.getByRole('grid', { name: 'Таблица Markdown' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Сценарий' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'mid' })).toBeVisible();
  await expect(page.locator('[data-source]')).toHaveText(source);
});

test('Таблица не исчезает и не меняет высоту при быстром возврате вверх', { timeout }, async t => {
  // Arrange: таблица с переносами текста, которую редактор может выгрузить при прокрутке.
  const rows = Array.from({ length: 24 }, (_, index) =>
    `| Строка ${index + 1} | ${'Описание значения в ячейке. '.repeat(9)}|`);
  const tail = Array.from({ length: 240 }, (_, index) => `Текст после таблицы ${index + 1}`);
  const source = ['Вступление', '', '| Поле | Описание |', '| --- | --- |', ...rows, '', ...tail].join('\n');
  const page = await fixture(t, source);
  const grid = page.getByRole('grid', { name: 'Таблица Markdown' });
  await expect(grid.getByRole('row')).toHaveCount(rows.length + 1);
  const widget = page.locator('.lp-table');
  const height = await widget.evaluate(element => element.getBoundingClientRect().height);
  const scroller = page.locator('.cm-scroller');
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(widget).toHaveCount(0);

  // Act: фиксируем высоту и строки в момент повторной вставки, до позднего рендера React.
  const remount = await scroller.evaluate(element => new Promise(resolve => {
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement) || !node.matches('.lp-table') || !node.isConnected) continue;
        observer.disconnect();
        resolve({
          height: node.getBoundingClientRect().height,
          rows: node.querySelectorAll('[role="row"]').length
        });
        return;
      }
    });
    observer.observe(element, { childList: true, subtree: true });
    element.scrollTop = 0;
  }));

  // Assert: таблица сразу возвращается целиком, без промежуточного пустого блока.
  assert.ok(Math.abs(remount.height - height) <= 1, `Высота после возврата: ${remount.height}, до прокрутки: ${height}`);
  assert.equal(remount.rows, rows.length + 1);
});

test('Ячейка открывает исходный Markdown и изменение можно отменить', { timeout }, async t => {
  const source = 'Вступление\n\n| Имя | Число |\n| --- | --- |\n| Один | два |\n\nПосле';
  const page = await fixture(t, source);

  await page.getByRole('gridcell', { name: 'два' }).click();
  await expect(page.getByRole('textbox')).toContainText('| Один | два |');
  const selection = JSON.parse(await page.locator('[data-selection]').textContent());
  assert.ok(selection.from >= source.indexOf('| два') && selection.from <= source.indexOf('| два') + 2);
  await page.keyboard.insertText('новое ');
  await expect(page.locator('[data-source]')).toContainText('новое');
  await page.keyboard.press('Meta+z');
  await expect(page.locator('[data-source]')).toHaveText(source);
  await page.locator('.cm-line').filter({ hasText: 'Вступление' }).click();
  await expect(page.getByRole('gridcell', { name: 'два' })).toBeVisible();
});

test('GFM-таблица сохраняет пустые ячейки, оформление и безопасные ссылки', { timeout }, async t => {
  const source = 'До\n\n| A | B | C |\n| :--- | :---: | ---: |\n| **жирный** | `a\\|b` | [ссылка](./note.md) |\n| один | | <img src=x onerror=alert(1)> |\n| коротко |\n\n```text\n| не | таблица |\n| --- | --- |\n```';
  const page = await fixture(t, source);

  const grid = page.getByRole('grid', { name: 'Таблица Markdown' });
  await expect(grid).toHaveCount(1);
  await expect(grid.locator('strong')).toHaveText('жирный');
  await expect(grid.locator('code')).toHaveText('a|b');
  await expect(grid.getByRole('row')).toHaveCount(4);
  await expect(grid.locator('img')).toHaveCount(0);
  await grid.getByRole('link', { name: 'ссылка' }).click({ modifiers: ['Meta'] });
  await expect(page.locator('[data-opened]')).toHaveText('["./note.md"]');
  await expect(page.locator('[data-source]')).toHaveText(source);
});

test('Таблица внутри цитаты отображает строки без потери исходника', { timeout }, async t => {
  const source = 'До\n\n> | A | B |\n> | --- | --- |\n> | один | два |\n\nПосле';
  const page = await fixture(t, source);

  await page.getByRole('gridcell', { name: 'два' }).click();
  const selection = JSON.parse(await page.locator('[data-selection]').textContent());
  assert.ok(selection.from >= source.indexOf('| два') && selection.from <= source.indexOf('| два') + 2);
  await expect(page.locator('[data-source]')).toHaveText(source);
});

test('Таблица без строк показывает заголовок и не изменяет Markdown', { timeout }, async t => {
  const source = 'До\n\n| A | B |\n| --- | --- |\n\nПосле';
  const page = await fixture(t, source);

  await expect(page.getByRole('columnheader', { name: 'A' })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Таблица Markdown' }).getByRole('row')).toHaveCount(1);
  await expect(page.locator('[data-source]')).toHaveText(source);
});

test('Таблица в начале документа отображается до первого ввода', { timeout }, async t => {
  const source = '| A | B |\n| --- | --- |\n| один | два |';
  const page = await fixture(t, source);

  await expect(page.getByRole('gridcell', { name: 'два' })).toBeVisible();
  await expect(page.locator('[data-source]')).toHaveText(source);
});

test('Режим только чтения не раскрывает исходник при выборе таблицы', { timeout }, async t => {
  const source = 'До\n\n| A | B |\n| --- | --- |\n| один | два |';
  const page = await fixture(t, source);
  await page.getByRole('button', { name: 'Только чтение' }).click();

  await page.getByRole('gridcell', { name: 'два' }).click();

  await expect(page.getByRole('grid', { name: 'Таблица Markdown' })).toBeVisible();
  await expect(page.locator('[data-source]')).toHaveText(source);
});

test('Таблица открывает Markdown с клавиатуры', { timeout }, async t => {
  const source = 'До\n\n| A | B |\n| --- | --- |\n| один | два |';
  const page = await fixture(t, source);

  await page.locator('.lp-table').focus();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('textbox')).toBeFocused();
  await expect(page.getByRole('textbox')).toContainText('| один | два |');
  await expect(page.locator('[data-source]')).toHaveText(source);
});

test('Перемещение курсора вне таблицы не пересоздаёт её', { timeout }, async t => {
  const source = 'До таблицы\n\n| A | B |\n| --- | --- |\n| один | два |';
  const page = await fixture(t, source);
  const editor = page.getByRole('textbox');
  await page.locator('.cm-line').filter({ hasText: 'До таблицы' }).click();
  const original = await page.getByRole('grid', { name: 'Таблица Markdown' }).elementHandle();

  await page.keyboard.press('ArrowLeft');

  assert.equal(await original.evaluate(element => element.isConnected), true);
  await expect(editor).toBeFocused();
});

test('Vim редактирует и отменяет изменение исходника таблицы', { timeout }, async t => {
  const source = 'До\n\n| A | B |\n| --- | --- |\n| один | два |';
  const page = await fixture(t, source);
  await page.getByRole('button', { name: 'Vim', exact: true }).click();
  await page.getByRole('gridcell', { name: 'два' }).click();

  await page.keyboard.press('i');
  await page.keyboard.insertText('новое');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-source]')).toContainText('новое');
  await page.keyboard.press('u');

  await expect(page.locator('[data-source]')).toHaveText(source);
});

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

for (const example of [
  { language: 'json', code: '{"enabled": true}', token: 'true' },
  { language: 'sh', code: 'bun run "$TARGET"', token: '$TARGET' },
  { language: 'py', code: 'def greet():\n    return "hello"', token: 'def' },
  { language: 'C#', code: 'public class Example {}', token: 'public' },
  { language: 'sql', code: 'SELECT * FROM documents', token: 'SELECT' }
]) {
  test(`Блок ${example.language} показывает метку языка и подсвечивает код`, { timeout }, async t => {
    // Arrange: добавить блок после обычного текста.
    const source = `Пример.\n\n\`\`\`${example.language}\n${example.code}\n\`\`\``;
    const page = await fixture(t, source);

    // Act: дождаться загрузки грамматики.
    const token = page.locator('.lp-code-line [class*="tok-"]').getByText(example.token, { exact: true });

    // Assert: токен выделен, метка справа заменяет исходный разделитель.
    await expect(token).toBeVisible();
    await expect(page.locator('.lp-code-start')).toHaveAttribute('data-code-language', example.language);
    await expect(page.getByRole('textbox')).not.toContainText('```');
    await expect(page.locator('[data-source]')).toHaveText(source);
  });
}

test('Блок с неизвестным языком показывает исходный код', { timeout }, async t => {
  // Arrange: подготовить блок на языке вне каталога.
  const source = 'Пример.\n\n~~~local-dsl\nshow <row>\n~~~';

  // Act: открыть исходник в редакторе.
  const page = await fixture(t, source);

  // Assert: метка и текст сохранены, разметка не интерпретируется.
  await expect(page.locator('.lp-code-start')).toHaveAttribute('data-code-language', 'local-dsl');
  await expect(page.locator('.lp-code-line').filter({ hasText: 'show <row>' })).toBeVisible();
  await expect(page.locator('.lp-code-line [class*="tok-"]')).toHaveCount(0);
});

test('Код с отступом оформляется без метки языка', { timeout }, async t => {
  // Arrange: между абзацами расположен блок без разделителей.
  const source = 'До.\n\n    code without a fence\n\nПосле.';

  // Act: открыть заметку.
  const page = await fixture(t, source);

  // Assert: только строка кода образует блок.
  const block = page.locator('.lp-code-start.lp-code-end');
  await expect(block).toContainText('code without a fence');
  await expect(block).not.toHaveAttribute('data-code-language');
});

test('Код редактируется на месте с отменой изменений', { timeout }, async t => {
  // Arrange: открыть блок с одним выражением.
  const source = 'Пример.\n\n```js\nconst value = 1;\n```';
  const page = await fixture(t, source);
  await page.locator('.lp-code-line').filter({ hasText: 'const value' }).click();

  // Act: вставить символ внутри строки с кодом.
  await page.keyboard.insertText('x');

  // Assert: изменить и восстановить исходный Markdown.
  await expect(page.locator('[data-source]')).not.toHaveText(source);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('[data-source]')).toHaveText(source);
});

test('Нажатие на строку метки раскрывает разделитель блока для правки', { timeout }, async t => {
  // Arrange: показать язык в заголовке закрытого блока.
  const page = await fixture(t, 'Пример.\n\n~~~sh\necho "hello"\n~~~');
  const header = page.locator('.lp-code-start');
  await expect(header).toHaveAttribute('data-code-language', 'sh');

  // Act: поставить курсор на строку разделителя.
  await header.click();

  // Assert: исходная строка доступна для редактирования.
  await expect(header).toContainText('~~~sh');
});

test('Перетаскивание мыши выделяет текст видимой строки после блочного виджета', { timeout }, async t => {
  // Arrange: разместить схему перед нумерованным списком.
  const word = 'медиана';
  const trailingText = '\n\nАбзац после списка.'.repeat(65);
  const source = `Текст\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n\n1. Первый пункт\n2. Расчёт: ${word}, прямая формула\n3. Следующий пункт${trailingText}`;
  const page = await fixture(t, source);
  const diagram = page.locator('.lp-diagram');
  const scroller = page.locator('.cm-scroller');
  await expect(diagram).toBeInViewport();
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(diagram).toHaveCount(0);
  await scroller.evaluate(element => { element.scrollTop = 0; });
  await expect(diagram).toBeInViewport();
  const line = page.locator('.cm-line').filter({ hasText: word });
  await line.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const { left, right, y } = await line.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent.indexOf(text);
      if (start < 0) continue;
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const rect = range.getBoundingClientRect();
      return { left: rect.left + 1, right: rect.right - 1, y: rect.top + rect.height / 2 };
    }
    throw new Error('Текст пункта списка не найден');
  }, word);

  // Act: провести указателем по слову во втором пункте.
  await page.mouse.move(left, y);
  await page.mouse.down();
  await page.mouse.move(right, y, { steps: 6 });
  await page.mouse.up();

  // Assert: проверить выделенный диапазон исходного Markdown.
  const from = source.indexOf(word);
  await expect(page.locator('[data-selection]')).toHaveText(JSON.stringify({ from, to: from + word.length }));
});

test('Многострочное выделение имеет только фон CodeMirror', { timeout }, async t => {
  // Arrange: добавить список и фрагмент кода с отдельным оформлением.
  const source = '1. Первый пункт с `кодом`\n2. Второй пункт\n\n## Итог';
  const page = await fixture(t, source);
  const editor = page.getByRole('textbox', { name: 'Текст заметки' });

  // Act: выделить несколько строк в редакторе.
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');

  // Assert: CodeMirror рисует фон, а браузер сохраняет диапазон без второго фона.
  const background = page.locator('.cm-selectionBackground').first();
  await expect(background).toBeVisible();
  await expect(background).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const code = page.locator('.lp-code').filter({ hasText: 'кодом' });
  const native = await code.evaluate(element => ({
    text: window.getSelection()?.toString(),
    background: getComputedStyle(element, '::selection').backgroundColor
  }));
  assert.ok(native.text?.includes('Второй пункт'));
  assert.equal(native.background, 'rgba(0, 0, 0, 0)');
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
