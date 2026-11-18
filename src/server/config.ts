import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MERMAID_THEMES } from '../shared/types.js';
import type { AppConfig, MermaidTheme } from '../shared/types.js';
import { InvalidRequestError } from './errors.js';

export const DEFAULT_DB = join(homedir(), '.livenote', 'livenote.sqlite');

export function parseConfig(args: string[], environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()):
  { command: 'serve'; config: AppConfig } | { command: 'migrate'; dbPath: string; vaultPath: string } | { command: 'migrate-vault'; sourcePath: string; vaultPath: string } | { command: 'help' } {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' }, open: { type: 'boolean', default: false },
      db: { type: 'string' }, vault: { type: 'string' }, 'from-vault': { type: 'string' }, theme: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false }
    }
  });
  if (values.help) return { command: 'help' };
  const command = positionals[0] ?? 'serve';
  if (positionals.length > 1 || !['serve', 'migrate'].includes(command)) throw new InvalidRequestError('Неизвестная команда');
  const path = (value: string, name: string): string => {
    if (!value.trim()) throw new InvalidRequestError(`${name} не может быть пустым`);
    return resolve(cwd, value);
  };
  if (command === 'migrate') {
    if (values['from-vault'] !== undefined) {
      if (values.db !== undefined || values.vault === undefined) throw new InvalidRequestError('migrate требует один источник и --vault');
      return { command: 'migrate-vault', sourcePath: path(values['from-vault'], '--from-vault'), vaultPath: path(values.vault, '--vault') };
    }
    if (values.db === undefined || values.vault === undefined) throw new InvalidRequestError('migrate требует --db и --vault');
    return { command, dbPath: path(values.db, '--db'), vaultPath: path(values.vault, '--vault') };
  }
  if (values['from-vault'] !== undefined) throw new InvalidRequestError('--from-vault доступен только для migrate');
  if (values.db !== undefined && values.vault !== undefined) throw new InvalidRequestError('--db и --vault нельзя использовать вместе');
  let dbPath = DEFAULT_DB;
  let vaultPath: string | undefined;
  if (values.vault !== undefined) vaultPath = path(values.vault, '--vault');
  else if (values.db !== undefined) dbPath = path(values.db, '--db');
  else {
    const vaultEnv = environment['LIVENOTE_VAULT'];
    const dbEnv = environment['LIVENOTE_DB'];
    if (vaultEnv !== undefined && !vaultEnv.trim()) throw new InvalidRequestError('LIVENOTE_VAULT не может быть пустым');
    if (dbEnv !== undefined && !dbEnv.trim()) throw new InvalidRequestError('LIVENOTE_DB не может быть пустым');
    if (vaultEnv && dbEnv) throw new InvalidRequestError('LIVENOTE_VAULT и LIVENOTE_DB нельзя использовать вместе');
    if (vaultEnv) vaultPath = path(vaultEnv, 'LIVENOTE_VAULT');
    else if (dbEnv) dbPath = path(dbEnv, 'LIVENOTE_DB');
    else vaultPath = resolve(cwd);
  }
  const rawPort = values.port ?? environment['LIVENOTE_PORT'] ?? '4317';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidRequestError(`Некорректный порт: ${rawPort}`);
  const rawTheme = values.theme ?? environment['LIVENOTE_THEME'] ?? 'default';
  const theme: MermaidTheme | undefined = MERMAID_THEMES.find(candidate => candidate === rawTheme);
  if (theme === undefined) throw new InvalidRequestError(`Неизвестная тема mermaid: "${rawTheme}"`);
  return { command: 'serve', config: {
    port, host: '127.0.0.1', dbPath, ...(vaultPath !== undefined ? { vaultPath } : {}),
    token: environment['LIVENOTE_TOKEN']?.trim() || null, openBrowser: values.open, mermaidTheme: theme
  } };
}
