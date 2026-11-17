import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { DEFAULT_DB, DEFAULT_VAULT, parseConfig } from './config.js';
import { migrateFromVault, migrateVault } from './vaultMigration.js';
import { MERMAID_THEMES } from '../shared/types.js';

const USAGE = `LiveNote — локальный визуальный блокнот.

  livenote [serve] [--vault <путь> | --db <путь>] [--port 4317] [--open]
  livenote migrate --db <SQLite> --vault <новый-каталог>
  livenote migrate --from-vault <старый-vault> --vault <новый-каталог>

По умолчанию: ${DEFAULT_VAULT}
--vault / LIVENOTE_VAULT: Markdown vault.
--db / LIVENOTE_DB: совместимый SQLite-режим.
--theme / LIVENOTE_THEME: ${MERMAID_THEMES.join(', ')}
LIVENOTE_PORT задаёт порт, LIVENOTE_TOKEN — bearer-токен.
--help показывает эту справку.`;

async function main(): Promise<void> {
  const selection = parseConfig(process.argv.slice(2));
  if (selection.command === 'help') { console.log(USAGE); return; }
  if (selection.command === 'migrate') {
    console.log(migrateVault(selection.dbPath, selection.vaultPath));
    return;
  }
  if (selection.command === 'migrate-vault') {
    console.log(migrateFromVault(selection.sourcePath, selection.vaultPath));
    return;
  }
  const { config } = selection;
  if (config.vaultPath !== undefined && existsSync(DEFAULT_DB)) {
    console.log(`Найдена прежняя база: ${DEFAULT_DB}`);
    console.log(`Для явной миграции: livenote migrate --db ${JSON.stringify(DEFAULT_DB)} --vault ${JSON.stringify(config.vaultPath + '-migrated')}`);
  }
  const running = await createApp(config);
  const url = `http://127.0.0.1:${config.port}`;
  const server = running.app.listen(config.port, config.host, () => {
    console.log(`LiveNote запущен: ${url}`);
    console.log(`  MCP: ${url}/mcp (Streamable HTTP)`);
    console.log(`  Хранилище: ${config.vaultPath ?? config.dbPath}`);
    console.log(`  Аутентификация: ${config.token ? 'включена' : 'отключена'}`);
  });
  server.on('error', async error => { console.error(error); await running.close(); process.exitCode = 1; });
  if (config.openBrowser) {
    try { await (await import('open')).default(url); }
    catch (error) { console.warn('Не удалось открыть браузер:', error); }
  }
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await running.close();
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch(error => { console.error('LiveNote завершился с ошибкой:', error); process.exitCode = 1; });
