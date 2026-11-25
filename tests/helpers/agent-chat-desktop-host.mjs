import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { originals } from './agent-chat-desktop-providers.mjs';

const readyPrefix = 'LIVENOTE_CHAT_FIXTURE_URL=';
const testName = 'http::chat_browser_host::serve_chat_browser_fixture';

export async function configureFixtureModel(host, { baseUrl, model, token }) {
  const response = await fetch(`${host.agentBase}/connections/model`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${host.token}`,
      'Content-Type': 'application/json',
      'X-LiveNote-Agent': '1'
    },
    body: JSON.stringify({
      profile: { kind: 'model', baseUrl, model },
      secret: { kind: 'token', value: token }
    }),
    signal: AbortSignal.timeout(5_000)
  });
  assert.equal(response.status, 200, `Rust не сохранил тестовое подключение: ${await response.text()}`);
}

export async function startChatHost(t, documents = originals, chromiumExecutable) {
  const root = await mkdtemp(join(tmpdir(), 'livenote-chat-fixture-'));
  const vault = join(root, 'vault');
  const token = randomUUID();
  let child;
  let exited;
  let log = '';
  const processGroup = process.platform !== 'win32';
  t.after(async () => {
    try {
      if (!child) return;
      child.stdin.end();
      const result = await Promise.race([exited, delay(5_000, null, { ref: false })]);
      if (result === null) {
        if (processGroup) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
        await exited;
      }
      t.diagnostic(`Rust PID=${child.pid}: ${JSON.stringify(await exited)}; временный каталог: ${root}`);
      assert.equal(result?.code, 0, `Rust не завершился штатно:\n${log}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(vault);
  await Promise.all(Object.entries(documents).map(([path, text]) => writeFile(join(vault, path), text)));

  const binary = process.env.LIVENOTE_CHAT_FIXTURE_BINARY;
  const testArgs = [testName, '--exact', '--ignored', '--nocapture'];
  const args = binary ? testArgs : [
    'test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'livenote',
    testName, '--', ...testArgs.slice(1)
  ];
  child = spawn(binary ?? 'cargo', args, {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...process.env,
      LIVENOTE_CHAT_FIXTURE_ROOT: root,
      LIVENOTE_CHAT_FIXTURE_TOKEN: token,
      LIVENOTE_CHAT_FIXTURE_CHROMIUM: chromiumExecutable
    },
    detached: processGroup,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin.on('error', error => { log += `${error.message}\n`; });
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk; });
  exited = new Promise(resolve => {
    child.once('error', error => { log += `${error.message}\n`; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout });
  const origin = await new Promise(resolve => {
    lines.on('line', line => {
      log += `${line}\n`;
      if (line.startsWith(readyPrefix)) resolve(line.slice(readyPrefix.length));
    });
    void exited.then(() => resolve(null));
    t.signal.addEventListener('abort', () => resolve(null), { once: true });
  });
  assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, `Rust не запустился:\n${log}`);
  const config = await (await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(5_000) })).json();
  assert.equal(config.agentChat, true);
  assert.equal(config.tokenRequired, true);
  assert.ok(config.defaultVaultId, 'Rust не открыл тестовое хранилище.');
  const agentBase = `${origin}/api/vaults/${config.defaultVaultId}/agent`;
  return { origin, agentBase, token, vault };
}
