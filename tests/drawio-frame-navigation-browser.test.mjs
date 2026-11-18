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
  directory = await mkdtemp(join(tmpdir(), 'livenote-drawio-navigation-'));
  await writeFile(join(directory, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await writeFile(join(directory, 'fixture.tsx'), `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useDrawioFrame } from ${JSON.stringify(join(project, 'src/web/components/useDrawioFrame.ts'))};
import { DrawioFullscreen } from ${JSON.stringify(join(project, 'src/web/components/DrawioFullscreen.tsx'))};
import ${JSON.stringify(join(project, 'src/web/heroui.css'))};
import ${JSON.stringify(join(project, 'src/web/styles.css'))};
const xml = '<mxfile><diagram name="Схема"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="start" value="Начало" vertex="1" parent="1"><mxGeometry x="80" y="80" width="160" height="64" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
function Fixture() {
  const [result, setResult] = useState('');
  const [editing, setEditing] = useState(false);
  const { iframeRef, ready, error, exportDiagram } = useDrawioFrame({ xml, frameKey: 'editor' });
  return <main><button disabled={!ready} onClick={() => {
    setResult('pending');
    void exportDiagram('svg').then(() => setResult('resolved'), error => setResult(error.message));
  }}>Экспорт</button><output id="result">{result}</output><output id="error">{error}</output>
  <iframe ref={iframeRef} title="Редактор draw.io"/><button onClick={() => setEditing(true)}>Открыть</button>
  {editing && <DrawioFullscreen block={{ id: 'block', pageId: 'page', source: xml, type: 'drawio', title: '' }}
    pageTitle="Схема" pageRevision={1} persisted={false} onCommit={async () => {}} onClose={() => setEditing(false)}/>}</main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  server = await createServer({
    configFile: false, root: directory, cacheDir: join(directory, 'cache'),
    publicDir: join(project, 'src/web/public'), plugins: [tailwindcss()], esbuild: { jsx: 'automatic' },
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

test('Настоящая перезагрузка отменяет ожидающий экспорт', { timeout }, async t => {
  // Arrange: удерживаем запрос экспорта после загрузки настоящего редактора.
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => {
    if (window !== window.top) return;
    document.addEventListener('load', event => {
      const frame = event.target;
      if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow || frame.contentWindow.location.pathname !== '/drawio/index.html') return;
      const target = frame.contentWindow;
      const send = target.postMessage;
      target.postMessage = function (data, origin, ...rest) {
        const message = JSON.parse(data);
        if (message.action === 'export') {
          window.exportHeld = true;
          return;
        }
        return send.call(target, data, origin, ...rest);
      };
    }, true);
  });
  await page.goto(base);
  await expect(page.getByRole('button', { name: 'Экспорт' })).toBeEnabled({ timeout });
  await page.getByRole('button', { name: 'Экспорт' }).click();
  await page.waitForFunction(() => window.exportHeld === true);
  await expect(page.locator('#result')).toHaveText('pending');

  // Act: браузер перезагружает тот же документ iframe.
  await page.locator('iframe').evaluate(frame => frame.contentWindow.location.reload());

  // Assert: защита сообщает об ошибке и отклоняет именно ожидающий экспорт.
  await expect(page.locator('#error')).toContainText('iframe был перезагружен', { timeout });
  await expect(page.locator('#result')).toContainText('iframe был перезагружен');
  await expect(page.getByRole('button', { name: 'Экспорт' })).toBeDisabled();
});

test('Переход iframe на чужой origin отклоняется', { timeout }, async t => {
  // Arrange: редактор завершает загрузку с локального origin.
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(base);
  await expect(page.getByRole('button', { name: 'Экспорт' })).toBeEnabled({ timeout });

  // Act: браузер открывает тот же сервер через другой origin.
  const foreignUrl = base.replace('127.0.0.1', 'localhost') + 'drawio/index.html';
  await page.locator('iframe').evaluate((frame, url) => { frame.src = url; }, foreignUrl);

  // Assert: редактор не принимает документ другого origin.
  await expect(page.locator('#error')).toContainText('чужой origin', { timeout });
  assert.equal(await page.getByRole('button', { name: 'Экспорт' }).isEnabled(), false);
});

test('Перезагрузка fullscreen сохраняет признак черновика и подтверждение отмены', { timeout }, async t => {
  // Arrange: открываем настоящую схему и изменяем текст фигуры.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole('button', { name: 'Открыть' }).click();
  const dialog = page.locator('.drawio-fullscreen');
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled({ timeout });
  const frame = dialog.locator('iframe');
  const canvas = frame.contentFrame().locator('.geDiagramContainer');
  await canvas.getByText('Начало', { exact: true }).dblclick({ timeout });
  const cell = frame.contentFrame().locator('.mxCellEditor[contenteditable="true"]:visible');
  await expect(cell).toBeFocused();
  await page.keyboard.type('Черновик');
  await page.keyboard.press('Escape');
  await expect(dialog.locator('.drawio-fullscreen__dirty')).toBeVisible();

  // Act: перезагружаем iframe после получения autosave.
  await frame.evaluate(element => element.contentWindow.location.reload());

  // Assert: ошибка не скрывает состояние черновика и не отменяет подтверждение.
  await expect(dialog.getByRole('alert')).toContainText('iframe был перезагружен', { timeout });
  await expect(dialog.locator('.drawio-fullscreen__dirty')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Отменить изменения?' })).toBeVisible();
  await page.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('Копирование fullscreen экспортирует изменённый XML', { timeout }, async t => {
  // Arrange: разрешаем доступ к буферу в отдельном контексте и изменяем схему.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'] });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole('button', { name: 'Открыть' }).click();
  const dialog = page.locator('.drawio-fullscreen');
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled({ timeout });
  const frame = dialog.locator('iframe').contentFrame();
  await frame.locator('.geDiagramContainer').getByText('Начало', { exact: true }).dblclick({ timeout });
  await expect(frame.locator('.mxCellEditor[contenteditable="true"]:visible')).toBeFocused();
  await page.keyboard.type('Новый текст');

  // Act: ждём завершения настоящей записи в буфер после копирования.
  const copied = page.evaluate(() => new Promise(resolve => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async text => {
      await write(text);
      resolve(text);
    };
  }));
  await dialog.getByRole('button', { name: 'Копировать исходник' }).click();
  const source = await copied;

  // Assert: полученный XML включает незафиксированный текст фигуры.
  assert.match(source, /Новый текст/);
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Новый текст/);
});
