import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, expect } from 'playwright/test';
import { createServer as createVite } from 'vite';
import { createApp } from '../src/server/app.ts';

const timeout = 60_000;
export const assertionTimeout = 4_000;
const screenshots = process.env.LIVENOTE_SCREENSHOT_DIR;
const vaultId = 'vault-test';
export const sessionOne = '11111111-1111-4111-8111-111111111111';
const sessionTwo = '22222222-2222-4222-8222-222222222222';
export const turnOne = '33333333-3333-4333-8333-333333333333';
const at = '2026-11-20T12:00:00Z';
const agentBase = `/api/vaults/${vaultId}/agent`;
const fixtureModule = `
  import React, { StrictMode, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { AgentBindingDialog } from '/agent/AgentBindingDialog.tsx';
  import { AgentChatPanel } from '/agent/AgentChatPanel.tsx';
  import { AgentConnectionsSettings } from '/agent/AgentConnectionsSettings.tsx';
  import { AgentContextSettings } from '/agent/AgentContextSettings.tsx';
  import { useAgentChat } from '/agent/useAgentChat.ts';
  import { SettingsDialog } from '/components/SettingsDialog.tsx';
  import { VaultEditors } from '/vault/VaultEditors.tsx';
  import { VaultWorkspaceLayout } from '/vault/VaultWorkspaceLayout.tsx';
  import { useVaultWorkspace } from '/vault/useVaultWorkspace.ts';
  import '/heroui.css';
  import '/styles.css';
  import '/vault.css';
  import '/agent/agent.css';
  function Fixture() {
    const workspace = useVaultWorkspace(false, false, null, false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [bindingOpen, setBindingOpen] = useState(false);
    const agentWorkspace = {
      ...workspace,
      captureAgentFocus: async () => {
        window.fixtureCaptures = (window.fixtureCaptures ?? 0) + 1;
        return { kind: 'folder', folder: 'services' };
      },
      finishAgentTurn: async changed => {
        window.fixtureFinished = [...(window.fixtureFinished ?? []), changed];
      }
    };
    const agentChat = useAgentChat({ vaultId: '${vaultId}', workspace: agentWorkspace, enabled: true });
    const panel = React.createElement(AgentChatPanel, {
      chat: agentChat,
      workspace: agentWorkspace,
      onClose: () => agentChat.setOpen(false), onOpenSettings: () => setSettingsOpen(true)
    });
    return React.createElement('div', { className: 'vault-app' },
      React.createElement('div', null,
        React.createElement('button', { onClick: () => agentChat.setOpen(true) }, 'Показать чат'),
        React.createElement('button', { onClick: () => setBindingOpen(true) }, 'Открыть привязку'),
        React.createElement('button', { onClick: () => setSettingsOpen(true) }, 'Открыть настройки')
      ),
      React.createElement(VaultWorkspaceLayout, {
        sidebar: React.createElement('span', null, 'Файлы'), agentPanel: panel, agentPanelOpen: agentChat.open,
        agentPanelWidth: agentChat.width, onAgentPanelWidthChange: agentChat.setWidth
      }, React.createElement(VaultEditors, {
        workspace, theme: 'light', vimEnabled: false, onRevealFolder() {}, agentPanel: panel
      })),
      settingsOpen && React.createElement(SettingsDialog, {
        pageWidth: 'standard', onPageWidthChange() {}, followEvents: false, onFollowChange() {},
        onClose: () => setSettingsOpen(false),
        agentConnections: React.createElement(React.Fragment, null,
          React.createElement(AgentContextSettings, {
            value: agentChat.contextLimitTokens, onChange: agentChat.setContextLimitTokens,
            search: agentChat.search, onSearchChange: agentChat.setSearch
          }),
          React.createElement(AgentConnectionsSettings, { vaultId: '${vaultId}' })
        )
      }),
      bindingOpen && React.createElement(AgentBindingDialog, {
        vaultId: '${vaultId}', folder: 'services/storage', onClose: () => setBindingOpen(false)
      })
    );
  }
  createRoot(document.querySelector('#root')).render(React.createElement(StrictMode, null, React.createElement(Fixture)));
`;

function initialState() {
  return {
    requests: [], apiRequests: [], polls: 0, releasePoll: true, pollFrames: null, connectionsError: false,
    sessions: [{ id: sessionOne, title: 'Первый разговор', updatedAt: at }],
    turns: [{ id: turnOne, text: 'Старый вопрос', at, status: 'done', answer: 'Старый ответ', cites: [], changed: [] }],
    binding: { value: { repo: null, localDir: null }, version: null },
    connections: [
      { profile: { kind: 'model', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture-model' }, state: 'ready' },
      { profile: { kind: 'confluence', endpoint: 'https://confluence.fixture/mcp', resourceHost: 'confluence.fixture' }, state: 'missing' },
      { profile: { kind: 'gitlab', endpoint: 'https://gitlab.fixture/mcp', resourceHost: 'gitlab.fixture' }, state: 'missing' },
      { profile: { kind: 'github', endpoint: 'https://github.fixture/mcp', resourceHost: 'github.fixture' }, state: 'missing' }
    ]
  };
}

async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

/**
 * Поднимает изолированный экземпляр: vite + реальный сервер + подменные agent-маршруты.
 * options.realApp — грузить настоящий VaultApp (index.html) вместо композиции фикстуры;
 * options.token — требовать bearer-токен на /api (нужен для сценария входа).
 */
export async function startAgentChatFixture({ token = null, realApp = false } = {}) {
  if (screenshots) await mkdir(screenshots, { recursive: true });
  let state;
  const temp = await mkdtemp(join(tmpdir(), 'livenote-agent-chat-'));
  const vault = join(temp, 'vault');
  await mkdir(vault);
  await writeFile(join(vault, 'note.md'), '# Заметка\n');
  let browser, server, app, vite, base;

  async function agentRequest(req, res) {
    const url = new URL(req.url, 'http://fixture');
    const path = url.pathname.slice(agentBase.length);
    const input = req.method === 'GET' ? {} : await body(req);
    state.requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body: input, agentHeader: req.headers['x-livenote-agent'] });
    if (path === '/sessions' && req.method === 'GET') return send(res, 200, state.sessions);
    if (path === '/sessions' && req.method === 'POST') {
      const summary = { id: input.id, title: `Разговор ${state.sessions.length + 1}`, updatedAt: at };
      state.sessions.unshift(summary);
      return send(res, 200, summary);
    }
    if (path === `/sessions/${sessionOne}` && req.method === 'GET') {
      return send(res, 200, { session: state.sessions.find(item => item.id === sessionOne), turns: state.turns });
    }
    if (path.startsWith('/sessions/') && req.method === 'GET' && !path.includes('/turns')) {
      const id = path.split('/')[2];
      return send(res, 200, { session: state.sessions.find(item => item.id === id), turns: [] });
    }
    if (path === `/sessions/${sessionOne}/turns` && req.method === 'POST') {
      state.turns = [...state.turns, { id: input.id, text: input.text, at, status: 'running' }];
      state.submitted = input;
      return send(res, 202, state.turns.at(-1));
    }
    if (path.startsWith(`/sessions/${sessionOne}/turns/`) && req.method === 'GET') {
      state.polls += 1;
      const frame = state.pollFrames?.shift();
      if (frame) {
        state.turns = state.turns.map(turn => turn.id === state.submitted.id ? { ...turn, ...frame } : turn);
      } else if (state.releasePoll && state.submitted) {
        state.turns = state.turns.map(turn => turn.id === state.submitted.id ? {
          ...turn, status: 'done', answer: 'Ответ агента', changed: ['docs/result.md'],
          cites: [{ kind: 'vault', path: 'docs/result.md', line: 3 }]
        } : turn);
      }
      return send(res, 200, state.turns.at(-1));
    }
    if (path === '/binding' && req.method === 'GET') return send(res, 200, state.binding);
    if (path === '/binding' && req.method === 'PUT') {
      state.binding = { value: input.value, version: 'sha256:fixture' };
      return send(res, 200, state.binding);
    }
    if (path === '/binding/pick' && req.method === 'POST') return send(res, 200, { localDir: '/tmp/livenote-fixture-code' });
    if (path === '/connections' && req.method === 'GET') {
      if (state.connectionsError) return send(res, 500, { error: { code: 'storage', message: 'Хранилище подключений недоступно.' } });
      return send(res, 200, state.connections);
    }
    if (path.startsWith('/connections/') && req.method === 'PUT') {
      const index = state.connections.findIndex(item => item.profile.kind === input.profile.kind);
      state.connections[index] = { profile: input.profile, state: 'ready' };
      return send(res, 200, state.connections[index]);
    }
    if (path.startsWith('/connections/') && path.endsWith('/oauth') && req.method === 'POST') return send(res, 202, {});
    return send(res, 404, { error: { code: 'not_found', message: `${req.method} ${path}` } });
  }

  async function handleFixtureRequest(req, res) {
    const { pathname } = new URL(req.url ?? '/', 'http://fixture');
    if (realApp && pathname === '/api/config') {
      // Настольный конфиг: agentChat включает панель, tokenRequired показывает форму входа.
      return send(res, 200, {
        version: 'fixture', tokenRequired: token !== null, mermaidTheme: 'default',
        storage: 'vault', agentChat: true, folderPickerAvailable: false
      });
    }
    if (pathname === '/') {
      const html = realApp
        ? await readFile(join(process.cwd(), 'src/web/index.html'), 'utf8')
        : '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/@id/agent-chat-fixture"></script>';
      const transformed = await vite.transformIndexHtml('/', html);
      return res.setHeader('Content-Type', 'text/html').end(transformed);
    }
    if (pathname.startsWith(agentBase)) return agentRequest(req, res);
    if (/^\/(?:api|events|drawio)(?:\/|$)/.test(pathname)) {
      if (realApp) state?.apiRequests.push(req.url ?? '');
      return app.app(req, res);
    }
    return vite.middlewares(req, res);
  }

  server = createServer((req, res) => {
    void handleFixtureRequest(req, res).catch(error => {
      if (!res.headersSent) send(res, 500, { error: { code: 'fixture_error', message: String(error) } });
      else res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
  app = await createApp({ port, host: '127.0.0.1', vaultPath: vault,
    dbPath: join(temp, 'unused.sqlite'), openBrowser: false, token, mermaidTheme: 'default' }, { cacheHome: join(temp, 'cache') });
  vite = await createVite({
    configFile: false, root: join(process.cwd(), 'src/web'), cacheDir: join(temp, 'vite'), appType: 'custom',
    server: { middlewareMode: true, hmr: false, fs: { allow: [process.cwd()] } },
    plugins: [react(), tailwindcss(), {
      name: 'agent-chat-fixture',
      resolveId(id) { if (id === 'agent-chat-fixture') return '\0agent-chat-fixture'; },
      load(id) { if (id === '\0agent-chat-fixture') return fixtureModule; }
    }]
  });
  async function newPage(t) {
    browser ??= await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    t.after(() => context.close());
    return context.newPage();
  }

  async function closeAgentChatFixture() {
    await browser?.close();
    if (server?.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    await vite?.close();
    await app?.close();
    await rm(temp, { recursive: true, force: true });
  }

  async function shot(page, name) {
    if (screenshots) await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true, animations: 'disabled' });
  }

  async function open(t) {
    const page = await newPage(t);
    await page.goto(base);
    const panel = page.getByRole('complementary', { name: 'Чат агента' });
    await expect(panel).toBeVisible({ timeout: assertionTimeout });
    await expect(panel.getByText('Старый ответ')).toBeVisible();
    return { page, panel };
  }

  /** Реальный VaultApp за формой входа: panel отсутствует до ввода токена. */
  async function openLogin(t) {
    const page = await newPage(t);
    await page.goto(`${base}/?vault_id=${encodeURIComponent(vaultId)}`);
    const dialog = page.getByRole('dialog', { name: 'LiveNote защищён токеном' });
    await expect(dialog).toBeVisible({ timeout: assertionTimeout });
    return { page, dialog };
  }

  return {
    url: `${base}/?vault_id=${encodeURIComponent(vaultId)}`,
    open, openLogin: realApp ? openLogin : undefined, shot,
    reset: () => { state = initialState(); return state; },
    get state() { return state; },
    close: closeAgentChatFixture
  };
}
