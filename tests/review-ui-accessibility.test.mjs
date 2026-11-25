import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, expect } from 'playwright/test';

const project = fileURLToPath(new URL('../', import.meta.url));
const timeout = 45_000;
let directory;
let evidence;
let server;
let browser;
let base;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'livenote-review-ui-'));
  evidence = process.env.LIVENOTE_UI_EVIDENCE ?? await mkdtemp(join(tmpdir(), 'livenote-review-ui-evidence-'));
  await mkdir(evidence, { recursive: true });
  await writeFile(join(directory, 'index.html'), '<html lang="ru"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  const module = file => JSON.stringify(join(project, 'src/web', file));
  await writeFile(join(directory, 'fixture.tsx'), String.raw`
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowDownToLine, EllipsisVertical} from '@gravity-ui/icons';
import {Button} from '@heroui/react';
import {LegacyApp} from ${module('LegacyApp.tsx')};
import {LivePreviewEditor} from ${module('editor/LivePreviewEditor.tsx')};
import {IconButton, VaultMenu} from ${module('vault/VaultControls.tsx')};
import {DiagramFullscreen} from ${module('components/DiagramFullscreen.tsx')};
import {DrawioFullscreen} from ${module('components/DrawioFullscreen.tsx')};
import {VaultApp} from ${module('vault/VaultApp.tsx')};
import ${module('heroui.css')};
import ${module('styles.css')};
import ${module('vault.css')};
const block = (type, source) => ({id:'block-'+type,pageId:'alpha',type,source,title:null,position:0,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',renderedRevision:null,renderOk:null,renderError:null});
const drawio = '<mxfile><diagram name="Схема"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
function Fixture() {
  const mode = new URLSearchParams(location.search).get('mode');
  const [source,setSource] = useState('# Заголовок\n\n## Раздел\n\n### Подраздел\n\nОсновной текст.');
  const [diagramOpen,setDiagramOpen] = useState(false);
  const [drawioOpen,setDrawioOpen] = useState(false);
  if (mode === 'legacy') return <LegacyApp/>;
  if (mode === 'editor') return <main style={{height:'90vh'}}><LivePreviewEditor source={source} onChange={setSource} renderDiagram={()=>null}/></main>;
  if (mode === 'controls') return <main style={{display:'flex',justifyContent:'space-between',padding:'16px'}}><IconButton label="Скачать документ" icon={ArrowDownToLine}/><VaultMenu label="Действия документа" triggerIcon={EllipsisVertical} actions={[{id:'copy',label:'Копировать путь'}]} onAction={()=>{}}/></main>;
  if (mode === 'mermaid') return <><button onClick={()=>setDiagramOpen(true)}>Открыть Mermaid</button>{diagramOpen && <DiagramFullscreen block={block('mermaid','flowchart TD\nA[Начало] --> B[Конец]')} pageTitle="Схема" pageRevision={1} persisted={false} onClose={()=>setDiagramOpen(false)}/>}</>;
  if (mode === 'drawio') return <><button onClick={()=>setDrawioOpen(true)}>Открыть draw.io</button>{drawioOpen && <DrawioFullscreen block={block('drawio',drawio)} pageTitle="Схема" pageRevision={1} persisted={false} onClose={()=>setDrawioOpen(false)}/>}</>;
  if (mode === 'vault') return <VaultApp config={{version:'test',tokenRequired:false,mermaidTheme:'default',storage:'vault',defaultVaultId:'alpha'}} vaultId="alpha" vaultIdExplicit/>;
  return <div className="app"><main className="page"><Button variant="danger-soft">Удалить</Button><div className="markdown-body"><pre><code>const theme = true;</code></pre></div></main></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: join(directory, 'cache'),
    publicDir: join(project, 'src/web/public'),
    plugins: [tailwindcss()],
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { react: join(project, 'node_modules/react'), 'react-dom': join(project, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [project, directory] } }
  });
  await server.listen();
  base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  console.log(`UI evidence: ${evidence}`);
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function open(t, mode, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() => {
    window.EventSource = class { constructor() {} close() {} addEventListener() {} removeEventListener() {} };
  });
  await page.goto(`${base}?mode=${mode}${mode === 'vault' ? '&vault_id=alpha' : ''}`);
  return page;
}

async function capture(page, name) {
  const path = join(evidence, `${process.env.LIVENOTE_UI_CAPTURE_PREFIX ?? ''}${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`capture: ${path}`);
}

async function mockLegacy(page, options = {}) {
  const summaries = ['alpha', 'beta', 'gamma'].map(id => ({ id, title: id.toUpperCase(), revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
  await page.addInitScript(() => {
    localStorage.setItem('livenote_open_tabs', JSON.stringify(['alpha', 'beta', 'gamma']));
    localStorage.setItem('livenote_active_tab', 'alpha');
  });
  await page.route('**/api/config', route => route.fulfill({ json: { version: 'test', tokenRequired: false, mermaidTheme: 'default', storage: 'sqlite' } }));
  await page.route('**/api/pages', async route => {
    if (options.pagesGate) await options.pagesGate;
    if (options.failPages) return route.fulfill({ status: 500, json: { error: { code: 'test', message: 'Тестовая ошибка загрузки' } } });
    return route.fulfill({ json: { pages: summaries } });
  });
  await page.route('**/api/pages/*', async route => {
    if (options.pagesGate) await options.pagesGate;
    const id = decodeURIComponent(route.request().url().split('/').at(-1));
    const source = id === 'alpha' ? '# Документ\n\n```js\nconst theme = true;\n```' : `# ${id.toUpperCase()}`;
    return route.fulfill({ json: { page: { ...summaries.find(item => item.id === id), blocks: [{ id: `block-${id}`, pageId: id, type: 'markdown', source, title: null, position: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', renderedRevision: null, renderOk: null, renderError: null }] } } });
  });
}

async function mockVault(page, delayDocument = false) {
  const document = {
    page: { id: 'Alpha.md', title: 'Alpha', revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', blocks: [] },
    path: 'Alpha.md', source: '# Alpha', version: 'version-1', spans: [], aliases: [], tags: [], assets: [], links: [], backlinks: []
  };
  await page.route('**/api/config', route => route.fulfill({ json: { version: 'test', tokenRequired: false, mermaidTheme: 'default', storage: 'vault', defaultVaultId: 'alpha' } }));
  await page.route('**/api/vaults/alpha/vault', route => route.fulfill({ json: { vaultName: 'Alpha', pages: [], files: [{ path: 'Alpha.md', kind: 'markdown', title: 'Alpha', version: 'version-1', revision: 1 }], folders: [''], treeVersion: 'tree-1', tags: [], problems: [] } }));
  await page.route('**/api/vaults/alpha/pages/Alpha.md/document', async route => {
    if (delayDocument) await delayDocument;
    return route.fulfill({ json: { document } });
  });
  await page.route('**/api/vaults/alpha/search', route => route.fulfill({ json: { hits: [] } }));
}

test('ui C1: danger, code и ошибка используют семантические цвета в обеих темах', { timeout }, async t => {
  const page = await open(t, 'colors');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.classList.toggle('dark', value === 'dark'); }, theme);
    const button = page.getByRole('button', { name: 'Удалить' });
    await button.hover();
    await expect(button).toHaveAttribute('data-hovered', 'true');
    const colors = await page.evaluate(() => {
      const read = selector => getComputedStyle(document.querySelector(selector));
      const token = value => { const probe = document.createElement('div'); probe.style.color = `var(${value})`; document.body.append(probe); const result = getComputedStyle(probe).color; probe.remove(); return result; };
      return { dangerBackground: read('.button--danger-soft').backgroundColor, dangerColor: read('.button--danger-soft').color, dangerToken: token('--danger-soft-foreground'), codeBackground: read('.markdown-body pre').backgroundColor, codeColor: read('.markdown-body pre').color };
    });
    console.log(`C1 ${theme}: ${JSON.stringify(colors)}`);
    await capture(page, `c1-${theme}`);
    assert.equal(colors.dangerColor, colors.dangerToken, `Тема ${theme}: ${JSON.stringify(colors)}`);
    assert.notEqual(colors.codeBackground, 'rgba(0, 0, 0, 0)');
  }
});

test('ui C2: CodeMirror использует шкалу Tailwind для текста и заголовков', { timeout }, async t => {
  const page = await open(t, 'editor');
  await expect(page.locator('.lp-heading-1')).toContainText('Заголовок');
  const sizes = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const actual = selector => getComputedStyle(document.querySelector(selector)).fontSize;
    const token = name => { const probe = document.createElement('div'); probe.style.fontSize = `var(${name})`; document.body.append(probe); const value = getComputedStyle(probe).fontSize; probe.remove(); return value; };
    return { body: actual('.cm-editor'), bodyToken: token('--text-base'), h1: actual('.lp-heading-1'), h1Token: token('--text-3xl'), h2: actual('.lp-heading-2'), h2Token: token('--text-2xl'), h3: actual('.lp-heading-3'), h3Token: token('--text-xl') };
  });
  console.log(`C2: ${JSON.stringify(sizes)}`);
  await capture(page, 'c2-editor');
  assert.deepEqual(sizes, { body: sizes.bodyToken, bodyToken: sizes.bodyToken, h1: sizes.h1Token, h1Token: sizes.h1Token, h2: sizes.h2Token, h2Token: sizes.h2Token, h3: sizes.h3Token, h3Token: sizes.h3Token });
});

test('ui H1: вкладки выбираются стрелками и сохраняют фокус после закрытия', { timeout }, async t => {
  const page = await open(t, 'legacy');
  await mockLegacy(page);
  await page.reload();
  const alpha = page.getByRole('tab', { name: /ALPHA/ });
  await expect(alpha).toBeVisible();
  await capture(page, 'h1-tabs-before-close');
  await alpha.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /BETA/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Закрыть BETA' }).click();
  await expect(page.getByRole('tab', { name: /GAMMA/ })).toBeFocused();
  await expect(page.getByRole('tab', { name: /GAMMA/ })).toHaveAttribute('aria-selected', 'true');
  await capture(page, 'h1-tabs-after-close');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark'); });
  await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
  await capture(page, 'h1-tabs-dark');
});

for (const key of ['Enter', 'Space']) {
  test(`ui H2: импорт открывает файловый диалог клавишей ${key}`, { timeout }, async t => {
    const page = await open(t, 'legacy');
    await mockLegacy(page);
    await page.reload();
    const button = page.getByRole('button', { name: 'Импорт .md' });
    await button.focus();
    await capture(page, `h2-import-${key.toLowerCase()}`);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press(key);
    assert.equal((await chooser).isMultiple(), false);
  });
}

test('ui H3: поля имеют имена, а ошибка связана с исходником блока', { timeout }, async t => {
  const page = await open(t, 'legacy');
  await mockLegacy(page);
  await page.reload();
  await page.locator('.page__title').click();
  await capture(page, 'h3-title-field');
  await expect(page.getByRole('textbox', { name: 'Заголовок страницы' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.block').hover();
  await page.getByRole('button', { name: 'Редактировать' }).click();
  const source = page.getByRole('textbox', { name: 'Исходник блока Markdown' });
  await source.fill('');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const error = page.getByText('Содержимое блока не может быть пустым');
  await expect(error).toBeVisible();
  assert.ok(await source.getAttribute('aria-describedby'));
  assert.equal(await source.getAttribute('aria-invalid'), 'true');
  await capture(page, 'h3-field-error');
});

test('ui H4: Tooltip показывается при фокусе, связан с кнопкой и остаётся в окне', { timeout }, async t => {
  const page = await open(t, 'controls');
  const button = page.getByRole('button', { name: 'Действия документа' });
  await button.focus();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Действия документа');
  const relation = await button.getAttribute('aria-describedby');
  assert.ok(relation && relation.split(' ').includes(await tooltip.getAttribute('id')));
  const bounds = await tooltip.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1440);
  await capture(page, 'h4-tooltip-focus');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark'); });
  await expect(tooltip).toBeVisible();
  await capture(page, 'h4-tooltip-dark');
});

test('ui H5: Mermaid Modal удерживает фокус, закрывается Escape и возвращает фокус', { timeout }, async t => {
  const page = await open(t, 'mermaid');
  const trigger = page.getByRole('button', { name: 'Открыть Mermaid' });
  await capture(page, 'h5-mermaid-before');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Схема — схема Mermaid' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Начало');
  await capture(page, 'h5-mermaid-modal');
  assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await capture(page, 'h5-mermaid-focus-return');
});

test('ui H5: draw.io Modal сохраняет iframe и возвращает фокус после отмены', { timeout }, async t => {
  const page = await open(t, 'drawio');
  const trigger = page.getByRole('button', { name: 'Открыть draw.io' });
  await capture(page, 'h5-drawio-before');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Схема — схема draw.io' });
  await expect(dialog).toBeVisible();
  const frame = page.locator('.drawio-fullscreen__frame');
  await expect(frame.contentFrame().locator('.geDiagramContainer')).toBeVisible({ timeout: 30_000 });
  await capture(page, 'h5-drawio-modal');
  await frame.contentFrame().locator('.geDiagramContainer').click({ position: { x: 500, y: 400 } });
  assert.equal(await frame.evaluate(element => element === document.activeElement), true);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await capture(page, 'h5-drawio-focus-return');
});

test('ui H5: Mermaid Modal сохраняет содержимое при 390px в тёмной теме', { timeout }, async t => {
  const page = await open(t, 'mermaid', { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark'); });
  await page.getByRole('button', { name: 'Открыть Mermaid' }).click();
  const dialog = page.getByRole('dialog', { name: 'Схема — схема Mermaid' });
  await expect(dialog).toContainText('Начало');
  assert.ok(await dialog.evaluate(element => element.getBoundingClientRect().width <= 390));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
  await capture(page, 'h5-mermaid-mobile-dark');
});

test('ui H5: draw.io Modal сохраняет iframe при 390px в тёмной теме', { timeout }, async t => {
  const page = await open(t, 'drawio', { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark'); });
  await page.getByRole('button', { name: 'Открыть draw.io' }).click();
  const dialog = page.getByRole('dialog', { name: 'Схема — схема draw.io' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.drawio-fullscreen__frame').contentFrame().locator('.geDiagramContainer')).toBeVisible({ timeout: 30_000 });
  assert.ok(await dialog.evaluate(element => element.getBoundingClientRect().width <= 390));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
  await capture(page, 'h5-drawio-mobile-dark');
});

test('ui H6: SQLite показывает HeroUI Spinner с уменьшенной анимацией', { timeout }, async t => {
  const page = await open(t, 'colors', { reducedMotion: 'reduce' });
  let releasePages;
  const pagesGate = new Promise(resolve => { releasePages = resolve; });
  await mockLegacy(page, { pagesGate });
  await page.goto(`${base}?mode=legacy`);
  const spinner = page.locator('.spinner');
  await expect(spinner).toBeVisible();
  await expect(spinner.locator('[data-slot="spinner-icon"]')).toBeHidden();
  await expect(page.locator('.legacy-loading')).toContainText('Загрузка страниц');
  await capture(page, 'h6-sqlite-spinner-reduced-motion');
  releasePages();
  await expect(page.getByRole('tab', { name: /ALPHA/ })).toBeVisible();
});

test('ui H6: SQLite показывает ошибку загрузки в HeroUI Alert', { timeout }, async t => {
  const page = await open(t, 'legacy');
  await mockLegacy(page, { failPages: true });
  await page.reload();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Тестовая ошибка загрузки');
  await expect(alert.locator('.alert__content')).toContainText('Тестовая ошибка загрузки');
  await capture(page, 'h6-sqlite-alert');
});

test('ui H6: Vault показывает HeroUI Spinner с уменьшенной анимацией', { timeout }, async t => {
  const page = await open(t, 'vault', { reducedMotion: 'reduce' });
  let releaseDocument;
  const documentGate = new Promise(resolve => { releaseDocument = resolve; });
  await mockVault(page, documentGate);
  await page.reload();
  await capture(page, 'h6-vault-before-loading');
  await page.locator('.vault-tree__page').filter({ hasText: 'Alpha' }).click();
  const spinner = page.locator('.vault-loading .spinner');
  await expect(spinner).toBeVisible();
  await expect(spinner.locator('[data-slot="spinner-icon"]')).toBeHidden();
  await expect(page.locator('.vault-loading')).toContainText('Загрузка документа');
  await capture(page, 'h6-vault-spinner-reduced-motion');
  releaseDocument();
  await expect(page.locator('.cm-content')).toContainText('Alpha');
});

test('ui H6: Vault показывает ошибку документа рядом с рабочей областью', { timeout }, async t => {
  const page = await open(t, 'vault');
  await mockVault(page);
  await page.unroute('**/api/vaults/alpha/pages/Alpha.md/document');
  await page.route('**/api/vaults/alpha/pages/Alpha.md/document', route => route.fulfill({ status: 500, json: { error: { code: 'test', message: 'Документ недоступен' } } }));
  await page.reload();
  await capture(page, 'h6-vault-before-error');
  await page.locator('.vault-tree__page').filter({ hasText: 'Alpha' }).click();
  await expect(page.getByRole('alert')).toContainText('Документ недоступен');
  await capture(page, 'h6-vault-alert');
});
