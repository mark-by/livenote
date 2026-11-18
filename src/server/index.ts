import { once } from 'node:events';
import { existsSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { createApp, type RunningApp } from './app.js';
import { DEFAULT_DB, parseConfig } from './config.js';
import { migrateFromVault, migrateVault } from './vaultMigration.js';
import { MERMAID_THEMES } from '../shared/types.js';

const USAGE = `LiveNote — локальный визуальный блокнот.

  livenote [serve] [--vault <путь> | --db <путь>] [--port 4317] [--open]
  livenote migrate --db <SQLite> --vault <новый-каталог>
  livenote migrate --from-vault <старый-vault> --vault <новый-каталог>

По умолчанию: текущий каталог.
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
  const desktop = process.env['LIVENOTE_DESKTOP_CHILD'] === '1';
  const url = `http://127.0.0.1:${config.port}`;
  const shutdown = new AbortController();
  const stopped = once(shutdown.signal, 'abort');
  const requestShutdown = (): void => {
    if (shutdown.signal.aborted) return;
    shutdown.abort();
    if (desktop) {
      // После гибели GUI закрытие stdin заменяет сигнал и ограничивает время завершения.
      setTimeout(() => process.exit(1), 10_000).unref();
    }
  };
  const reportFailure = (error: unknown): void => {
    console.error('[livenote] ошибка сервера:', error);
    process.exitCode = 1;
    requestShutdown();
  };
  let running: RunningApp | undefined;
  const server = createServer((req, res) => {
    if (running === undefined) {
      res.writeHead(503);
      res.end();
      return;
    }
    running.app(req, res);
  });

  process.on('SIGINT', requestShutdown);
  process.on('SIGTERM', requestShutdown);
  if (desktop) {
    process.stdin.once('end', requestShutdown);
    process.stdin.on('error', reportFailure);
    process.stdin.resume();
  }
  try {
    // Занимаем порт до открытия хранилища и запуска валидаторов.
    server.listen(config.port, config.host);
    try {
      await once(server, 'listening', { signal: shutdown.signal });
    } catch (error) {
      if (shutdown.signal.aborted && error instanceof Error && error.name === 'AbortError') return;
      if (desktop && error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
        writeSync(1, 'LIVENOTE_DESKTOP/1 PORT_IN_USE\n');
      }
      throw error;
    }
    server.on('error', reportFailure);
    if (shutdown.signal.aborted) return;
    running = await createApp(config);
    if (shutdown.signal.aborted) return;

    if (desktop) {
      // Только потомок, который занял порт и подготовил Express, сообщает о готовности.
      writeSync(1, 'LIVENOTE_DESKTOP/1 READY\n');
    }
    console.log(`LiveNote запущен: ${url}`);
    console.log(`  MCP: ${url}/mcp (Streamable HTTP)`);
    console.log(`  Хранилище: ${config.vaultPath ?? config.dbPath}`);
    console.log(`  Аутентификация: ${config.token ? 'включена' : 'отключена'}`);
    if (config.openBrowser) {
      // Открытие браузера не задерживает завершение сервера по сигналу.
      void import('open').then(({ default: open }) => open(url)).catch(error => {
        console.warn('Не удалось открыть браузер:', error);
      });
    }
    await stopped;
  } finally {
    try {
      // До окончания операций валидатора draw.io сервер продолжает отдавать статику.
      await running?.close();
    } finally {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      process.off('SIGINT', requestShutdown);
      process.off('SIGTERM', requestShutdown);
      if (desktop) {
        process.stdin.off('end', requestShutdown);
        process.stdin.off('error', reportFailure);
        process.stdin.pause();
      }
    }
  }
}

main().catch(error => { console.error('LiveNote завершился с ошибкой:', error); process.exitCode = 1; });
