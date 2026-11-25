import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { bpmnAnswer, bpmnFlows, bpmnLabels, bpmnPagePath, bpmnPageTitle, bpmnQuestion, bpmnTitle } from './helpers/agent-chat-bpmn-fixture.mjs';
import { configureFixtureModel, startChatHost } from './helpers/agent-chat-desktop-host.mjs';
import {
  diagramAnswer, diagramFile, diagramMarkdown, diagramQuestion, diagramTitle,
  docsQuestion, editQuestion, marker, mcpQuestion, model, originals, overviewAnswer,
  overviewFile, overviewQuestion, providers, remoteTitle
} from './helpers/agent-chat-desktop-providers.mjs';

const timeout = 420_000;
const browserTimeout = 12_000;
const visible = expect.configure({ timeout: browserTimeout });
const chromiumExecutable = process.env.LIVENOTE_CHAT_FIXTURE_CHROMIUM ?? chromium.executablePath();
const launchOptions = { executablePath: process.env.LIVENOTE_CHAT_FIXTURE_CHROMIUM };
const files = Object.entries(originals);
const noteFiles = async vault => (await readdir(vault, { recursive: true }))
  .filter(path => path !== '.livenote' && !path.startsWith('.livenote/'))
  .sort();

async function login(page, host) {
  const response = await page.goto(host.origin);
  assert.equal(response.status(), 200, 'Rust не отдал рабочий интерфейс.');
  const dialog = page.getByRole('dialog', { name: 'LiveNote защищён токеном' });
  const open = dialog.getByRole('button', { name: 'Открыть' });
  await visible(open).toBeDisabled();
  await dialog.getByLabel('Токен', { exact: true }).fill(host.token);
  await open.click();
  await visible(dialog).toBeHidden();
}

async function configureConnections(page, fixture) {
  await page.getByRole('button', { name: 'Меню LiveNote' }).click();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  await visible(dialog.getByText('Тема Mermaid', { exact: true })).toBeVisible();
  await visible(dialog.getByText('Ширина страницы', { exact: true })).toBeVisible();
  await visible(dialog.getByRole('switch', { name: 'Vim mode' })).toBeVisible();
  await visible(dialog.getByRole('switch', { name: 'Следовать за изменениями' })).toBeVisible();
  const modelSection = dialog.getByRole('region', { name: 'Модель' });
  const confluence = dialog.getByRole('region', { name: 'Confluence' });
  await visible(modelSection).toBeVisible();
  for (const name of ['Модель', 'Confluence', 'GitLab', 'GitHub']) {
    const section = dialog.getByRole('region', { name });
    await visible(section).toBeVisible();
    await visible(section.getByLabel('Токен')).toHaveValue('');
    if (name !== 'Модель') {
      await visible(section.getByLabel('MCP endpoint')).toHaveValue('');
      await visible(section.getByLabel('Resource host')).toHaveValue('');
      await visible(section.getByRole('button', { name: 'Войти через браузер' })).toBeDisabled();
    }
  }
  const evidence = await mkdtemp(join(tmpdir(), 'livenote-agent-browser-'));
  await page.screenshot({ path: join(evidence, 'пустые-подключения.png'), fullPage: true, animations: 'disabled' });
  await modelSection.getByLabel('Base URL').fill(`${fixture.base}/v1`);
  await modelSection.getByLabel('Модель', { exact: true }).fill(model);
  await modelSection.getByLabel('Токен').fill(fixture.token);
  await modelSection.getByRole('button', { name: 'Сохранить подключение' }).click();
  await visible(modelSection.getByText('Подключено', { exact: true })).toBeVisible();
  await visible(modelSection.getByLabel('Токен')).toHaveValue('');
  await confluence.getByLabel('MCP endpoint').fill(`${fixture.base}/mcp`);
  await confluence.getByLabel('Resource host').fill(fixture.resourceHost);
  await confluence.getByLabel('Токен').fill(fixture.token);
  await confluence.getByRole('button', { name: 'Сохранить подключение' }).click();
  await visible(confluence.getByText('Подключено', { exact: true })).toBeVisible();
  await visible(confluence.getByLabel('Токен')).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  await visible(dialog.getByRole('region', { name: 'GitHub' })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'подключения-мобильные.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
  await visible(dialog).toBeHidden();
  return evidence;
}

async function submit(panel, question, answer) {
  await panel.getByRole('textbox', { name: 'Сообщение агенту' }).fill(question);
  await panel.getByRole('button', { name: 'Отправить', exact: true }).click();
  const turn = panel.getByRole('article').filter({ hasText: question });
  const reply = turn.getByText(answer, { exact: true });
  const fault = turn.getByRole('alert');
  await visible(reply.or(fault)).toBeVisible();
  if (await fault.isVisible()) assert.fail(await fault.innerText());
  return turn;
}

async function openDiagramChat(t, fixture) {
  const host = await startChatHost(t, originals, chromiumExecutable);
  await configureFixtureModel(host, { baseUrl: `${fixture.base}/v1`, model, token: fixture.token });
  const browser = await chromium.launch(launchOptions);
  t.after(() => browser.close());
  t.diagnostic(`Chrome ${browser.version()}: ${chromiumExecutable}`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(browserTimeout);
  await login(page, host);
  const panel = page.getByRole('complementary', { name: 'Чат агента' });
  await panel.getByRole('button', { name: 'Новый разговор', exact: true }).first().click();
  await visible(panel.getByRole('heading', { name: 'Спросите о проекте' })).toBeVisible();
  return { host, page, panel };
}

test('Чат LiveNote через Rust HTTP: подключает источники и публикует правки', { timeout }, async t => {
  // Arrange: Rust открывает временное хранилище без сохранённых подключений.
  const fixture = await providers(t);
  const documents = { ...originals, [overviewFile]: `# Альтаир\n\n${overviewAnswer}\n` };
  const host = await startChatHost(t, documents);
  const sessionsUrl = `${host.agentBase}/sessions`;
  const unauthenticated = await fetch(sessionsUrl, {
    headers: { 'X-LiveNote-Agent': '1' }, signal: AbortSignal.timeout(5_000)
  });
  assert.equal(unauthenticated.status, 401, 'Rust должен отклонить запрос без токена.');
  const browser = await chromium.launch(launchOptions);
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(browserTimeout);

  // Act: входим через форму, настраиваем подключения и создаём разговор.
  await login(page, host);
  const panel = page.getByRole('complementary', { name: 'Чат агента' });
  const evidence = await configureConnections(page, fixture);
  t.diagnostic(`Общее меню открыло настройки. Модель и Confluence настроены через диалог. Снимки: ${evidence}`);
  const empty = panel.getByRole('heading', { name: 'Начните разговор' });
  await visible(empty).toBeVisible();
  const [session] = await Promise.all([
    page.waitForResponse(response => response.url() === sessionsUrl && response.request().method() === 'POST'),
    panel.getByRole('button', { name: 'Новый разговор', exact: true }).first().click()
  ]);
  assert.ok(session.ok(), `Rust не создал разговор: HTTP ${session.status()}`);
  t.diagnostic('Rust вернул 401 без токена и создал разговор после входа через форму.');

  // Assert: чат показывает источник каждого ответа. Локальный ответ не требует MCP.
  const docs = await submit(panel, docsQuestion, 'По регламенту маяк янтарный.');
  const docsSource = docs.getByRole('region', { name: 'Источники' }).getByRole('button', { name: 'Регламент.md:3', exact: true });
  await visible(docs.locator('.agent-markdown strong')).toHaveText('янтарный');
  await visible(docs.locator('.agent-markdown')).not.toContainText(/Регламент\.md|"(answer|cites)"\s*:/);
  await docsSource.click();
  const activeDocument = page.locator('.vault-document:not([hidden])');
  await visible(activeDocument).toHaveAttribute('data-page-id', 'Регламент.md');
  assert.deepEqual(fixture.calls.mcp, []);

  const overview = await submit(panel, overviewQuestion, overviewAnswer);
  await visible(overview.getByRole('button', { name: `${overviewFile}:1`, exact: true })).toBeVisible();
  assert.deepEqual(fixture.calls.mcp, []);
  t.diagnostic('Общий вопрос: браузер показал ответ и источник из README без вызова MCP.');

  const remote = await submit(panel, mcpQuestion, 'Резервный сигнал фиолетовый.');
  const citation = remote.getByRole('region', { name: 'Источники' }).getByRole('link', { name: remoteTitle, exact: true });
  await visible(citation).toBeVisible();
  await visible(citation).toHaveAttribute('href', `${fixture.base}/wiki/10`);
  const [sourcePage] = await Promise.all([page.waitForEvent('popup'), citation.click()]);
  await visible(sourcePage.locator('body')).toHaveText(remoteTitle);
  await sourcePage.close();
  assert.deepEqual(
    fixture.calls.mcp.filter(call => call.startsWith('confluence_')),
    ['confluence_search', 'confluence_get_page']
  );

  const edited = await submit(panel, editQuestion, 'Отметка добавлена в обе заметки.');
  assert.deepEqual([...new Set(fixture.calls.model)], [docsQuestion, overviewQuestion, mcpQuestion, editQuestion]);
  const changedFiles = edited.getByRole('button', { name: 'Изменённые файлы 2', exact: true });
  await visible(changedFiles).toBeVisible();
  await changedFiles.click();
  for (const [path, text] of files) {
    await visible(edited.getByText(path, { exact: true })).toBeVisible();
    assert.deepEqual(await readFile(join(host.vault, path)), Buffer.from(text + marker), path);
    t.diagnostic(`Проверена запись на диск: ${path}`);
  }
  await changedFiles.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, 'диалог.png') });
  t.diagnostic(`Снимок интерфейса: ${join(evidence, 'диалог.png')}`);

  assert.deepEqual(fixture.calls.policy, [mcpQuestion, editQuestion]);
});

test('Desktop-чат публикует заметку и показывает встроенную схему Mermaid', { timeout }, async t => {
  // Arrange: в тестовом хранилище нет заметки или файлов схемы.
  const fixture = await providers(t);
  const { host, page, panel } = await openDiagramChat(t, fixture);
  const initialFiles = await noteFiles(host.vault);
  const evidence = await mkdtemp(join(tmpdir(), 'livenote-agent-diagram-'));

  // Act: создаём новую страницу со встроенной схемой одним сообщением.
  const tree = page.getByRole('navigation', { name: 'Файлы хранилища' });
  const diagramPage = tree.getByRole('button', { name: diagramTitle, exact: true });
  await visible(diagramPage).toHaveCount(0);
  const created = await submit(panel, diagramQuestion, diagramAnswer);
  const changed = created.getByRole('button', { name: 'Изменённые файлы 1', exact: true });
  await changed.click();
  await visible(created.getByText(diagramFile, { exact: true })).toBeVisible();
  assert.equal(await readFile(join(host.vault, diagramFile), 'utf8'), diagramMarkdown);
  assert.deepEqual(await noteFiles(host.vault), [...initialFiles, diagramFile].sort());
  await diagramPage.click();

  // Assert: видны обе вершины и связь в настоящей схеме, а не текст блока Mermaid.
  const activeDocument = page.locator('.vault-document:not([hidden])');
  const svg = activeDocument.locator('.mermaid-block svg.flowchart');
  await visible(svg).toBeVisible();
  await visible(svg.locator('g.node')).toHaveText(['Принять заявку', 'Проверить данные']);
  await visible(svg.locator('path.flowchart-link')).toHaveCount(1);
  const diagramShot = join(evidence, 'схема.png');
  await page.screenshot({ path: diagramShot, animations: 'disabled' });
  t.diagnostic(`Отрисованная схема: ${diagramShot}`);

  assert.deepEqual(fixture.calls.policy, [diagramQuestion]);
});

test('Desktop-чат публикует заметку и показывает вложенную схему BPMN', { timeout }, async t => {
  // Arrange: в тестовом хранилище нет заметки о выпуске заказа.
  const fixture = await providers(t);
  const { host, page, panel } = await openDiagramChat(t, fixture);
  const tree = page.getByRole('navigation', { name: 'Файлы хранилища' });
  const note = tree.getByRole('button', { name: bpmnPageTitle, exact: true });
  await visible(note).toHaveCount(0);

  // Act: чат создаёт заметку и отдельный файл BPMN в одной операции.
  await submit(panel, bpmnQuestion, bpmnAnswer);
  const [{ assetPath }] = fixture.calls.diagram;
  const noteOnDisk = join(host.vault, bpmnPagePath);
  const assetOnDisk = join(host.vault, assetPath);
  const markdown = await readFile(noteOnDisk, 'utf8');
  const xml = await readFile(assetOnDisk, 'utf8');
  const embed = markdown.match(/^!\[[^\]]*\]\(<?([^<>\r\n]+?)>?\)$/m);
  assert.ok(embed, `В заметке нет ссылки на диаграмму:\n${markdown}`);
  assert.equal(posix.join(posix.dirname(bpmnPagePath), decodeURIComponent(embed[1])), assetPath);
  assert.doesNotMatch(markdown, /<\?xml|<bpmn:|```/i);
  assert.match(xml, /<(?:[\w-]+:)?BPMNDiagram\b/, 'Автоматическая раскладка не сохранила BPMN DI.');

  // Assert: редактор показывает подписи и обе связи в SVG, а не блок XML.
  await note.click();
  const document = page.locator('.vault-document:not([hidden])');
  await visible(document).toHaveAttribute('data-page-id', bpmnPagePath);
  const diagram = document.getByRole('region', { name: bpmnTitle, exact: true });
  const svg = diagram.locator('.bpmn-view-host .djs-container > svg');
  await visible(svg).toBeVisible();
  await visible.poll(() => svg.locator('text').evaluateAll(labels => labels.map(label =>
    [...label.querySelectorAll('tspan')].map(line => line.textContent.trim()).join(' ')).sort()))
    .toEqual([...bpmnLabels].sort());
  const links = svg.locator('.djs-connection .djs-visual > path');
  await visible(links).toHaveCount(bpmnFlows.length);
  for (const flow of bpmnFlows) {
    await visible(svg.locator(`[data-element-id="${flow}"].djs-connection .djs-visual > path`))
      .toHaveAttribute('d', /^M.+L/i);
  }
  await visible(document.locator('pre, code')).toHaveCount(0);
  const evidence = await mkdtemp(join(tmpdir(), 'livenote-agent-bpmn-'));
  await page.screenshot({ path: join(evidence, 'bpmn-page.png'), animations: 'disabled' });
  t.diagnostic(`Созданы ${bpmnPagePath} и ${assetPath}; SVG: ${bpmnLabels.join(' → ')}. Снимки: ${evidence}`);
});
