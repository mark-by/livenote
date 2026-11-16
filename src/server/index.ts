/**
 * CLI-точка входа LiveNote: парсинг аргументов, запуск сервера, открытие браузера.
 *
 *   livenote [serve] [--port 4317] [--open] [--db путь]
 *
 * Переменные окружения: LIVENOTE_PORT, LIVENOTE_DB, LIVENOTE_TOKEN (bearer для /mcp и /api).
 */
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from './app.js';
import { MERMAID_THEMES } from '../shared/types.js';
import type { MermaidTheme } from '../shared/types.js';

const DEFAULT_PORT = 4317;

const USAGE = `LiveNote — локальный визуальный блокнот для работы с AI-агентом.

Использование:
  livenote [serve] [опции]

Опции:
  -p, --port <номер>   порт сервера (по умолчанию 4317; env LIVENOTE_PORT)
      --open           открыть браузер после запуска
      --db <путь>      путь к SQLite-хранилищу (по умолчанию ~/.livenote/livenote.sqlite; env LIVENOTE_DB)
      --theme <имя>    тема mermaid для диаграмм (по умолчанию default; env LIVENOTE_THEME)
  -h, --help           показать эту справку

Переменные окружения:
  LIVENOTE_TOKEN       bearer-токен для /mcp и /api (если задан — аутентификация включена)
  LIVENOTE_THEME       тема mermaid для отрисовки диаграмм

Допустимые темы: ${MERMAID_THEMES.join(', ')}
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p', default: process.env['LIVENOTE_PORT'] ?? String(DEFAULT_PORT) },
      open: { type: 'boolean', default: false },
      db: { type: 'string', default: process.env['LIVENOTE_DB'] ?? join(homedir(), '.livenote', 'livenote.sqlite') },
      theme: { type: 'string', default: process.env['LIVENOTE_THEME'] ?? 'default' },
      help: { type: 'boolean', short: 'h', default: false }
    }
  });

  if (values.help === true) {
    console.log(USAGE);
    return;
  }

  const port = Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Некорректный порт: ${values.port}`);
    process.exit(1);
  }
  const dbPath = resolve(values.db);
  const token = process.env['LIVENOTE_TOKEN']?.trim() || null;
  if (!MERMAID_THEMES.includes(values.theme as MermaidTheme)) {
    console.error(`Неизвестная тема mermaid: "${values.theme}". Допустимые: ${MERMAID_THEMES.join(', ')}`);
    process.exit(1);
  }
  const mermaidTheme = values.theme as MermaidTheme;

  const config = {
    port,
    host: '127.0.0.1' as const,
    dbPath,
    token,
    openBrowser: values.open,
    mermaidTheme
  };

  const { app } = await createApp(config);

  const server = app.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('LiveNote запущен');
    console.log(`  Интерфейс: ${url}`);
    console.log(`  MCP:       ${url}/mcp (Streamable HTTP)`);
    console.log(`  Хранилище: ${dbPath}`);
    if (token) {
      console.log('  Аутентификация: включена (LIVENOTE_TOKEN)');
    } else {
      console.log('  Аутентификация: отключена (задайте LIVENOTE_TOKEN, чтобы включить)');
    }
    console.log('  Останов: Ctrl+C');
  });

  if (config.openBrowser) {
    try {
      const openModule = await import('open');
      await openModule.default(`http://127.0.0.1:${port}`);
    } catch (error) {
      console.warn('Не удалось открыть браузер:', error instanceof Error ? error.message : error);
    }
  }

  const shutdown = (signal: string): void => {
    console.log(`\nПолучен ${signal}, останавливаю LiveNote...`);
    server.close(() => process.exit(0));
    // Если сокеты не закрылись за 3 секунды — уходим принудительно.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('LiveNote завершился с ошибкой:', error);
  process.exit(1);
});
