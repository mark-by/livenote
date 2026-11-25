// allow: SIZE_OK — неделимый файловый journal writer/recovery использует одну проверку containment и no-follow.
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
  type BigIntStats
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VaultProblem } from '../shared/types.js';
import { AppError, InvalidRequestError } from './errors.js';
import { DocumentProblem, sha256 } from './vaultDocument.js';
import { ignoredPath, ignoreFile, parseIgnoredDirectories } from './vaultIgnore.js';

interface Change { path: string; old: string | null; next: string | null; oldHash: string | null; newHash: string | null }
export interface DirectoryChange { path: string; old: boolean; next: boolean }
interface PathRename { from: string; to: string }
interface Journal { id: string; changes: Change[]; directories?: DirectoryChange[]; rename?: PathRename }
export interface FileWrite { path: string; source: string | Buffer | null; expected: string | Buffer | null }

export function fileStamp(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}`;
}

export function decodeVaultText(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (error) {
    if (error instanceof TypeError) throw new DocumentProblem('unreadable_file', 'Файл не является UTF-8');
    throw error;
  }
}

export function validateVaultPath(path: string): void {
  if (typeof path !== 'string' || !path || /[\0\\]/.test(path) || /^(?:\/|[a-zA-Z]:)/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || ['.git', '.livenote'].includes(part))) {
    throw new InvalidRequestError('Путь должен быть относительным POSIX-путём без служебных каталогов');
  }
}
export function validateNotePath(path: string): void {
  validateVaultPath(path);
  if (!/\.(?:md|mmd|mermaid|bpmn|drawio)$/.test(path)) throw new InvalidRequestError('Неподдерживаемое расширение документа');
}

/** Все обращения к vault, включая operational state, проходят одну проверку. */
export class VaultFiles {
  readonly root: string;
  readonly recoveryProblems: VaultProblem[] = [];
  private rootIdentity: { dev: number; ino: number };
  private lockIdentity: string;
  private closed = false;
  private ignoreRules: ReadonlySet<string> = new Set();
  private ignoreStamp: string | null = null;
  private ignoreProblem?: VaultProblem;

  constructor(root: string) {
    const requested = resolve(root);
    if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) throw new InvalidRequestError('Корень vault не может быть символической ссылкой');
    mkdirSync(requested, { recursive: true });
    this.root = realpathSync(requested);
    const rootStat = lstatSync(this.root);
    if (!rootStat.isDirectory()) throw new InvalidRequestError('Vault должен быть каталогом');
    this.rootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
    this.parents('.livenote/lock');
    const lock = this.absolute('.livenote/lock');
    if (existsSync(lock)) {
      const prior = this.read('.livenote/lock').source;
      let pid: number;
      try { pid = (JSON.parse(prior) as { pid: number }).pid; } catch { throw new AppError('vault_locked', 'Некорректный lock vault', 409); }
      if (!Number.isInteger(pid) || pid < 1) throw new AppError('vault_locked', 'Некорректный PID lock vault', 409);
      try { process.kill(pid, 0); throw new AppError('vault_locked', 'Vault уже открыт другим процессом', 409); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        unlinkSync(lock);
      }
    }
    this.lockIdentity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    this.writeExclusive('.livenote/lock', this.lockIdentity);
    try {
      this.recover();
      if (this.optional('.livenote/.gitignore') === null) this.writeExclusive('.livenote/.gitignore', '*\n');
    } catch (error) { this.close(); throw error; }
  }

  absolute(path: string): string {
    this.checkRoot();
    if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new DocumentProblem('unsafe_path', 'Некорректный относительный путь');
    }
    const candidate = resolve(this.root, path);
    const inside = relative(this.root, candidate);
    if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
      throw new DocumentProblem('unsafe_path', 'Путь выходит за пределы vault');
    }
    let cursor = this.root;
    for (const component of path.split('/')) {
      cursor = join(cursor, component);
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw new DocumentProblem('unsafe_path', 'Символические ссылки запрещены');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        break;
      }
    }
    return candidate;
  }

  private checkRoot(): void {
    const current = lstatSync(this.root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== this.rootIdentity.dev || current.ino !== this.rootIdentity.ino) {
      throw new DocumentProblem('unsafe_path', 'Корневой каталог vault заменён');
    }
  }

  parents(path: string): void {
    const parts = path.split('/').slice(0, -1);
    let current = '';
    for (const part of parts) {
      current = current ? current + '/' + part : part;
      const absolute = this.absolute(current);
      try { mkdirSync(absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (!lstatSync(this.absolute(current)).isDirectory()) throw new DocumentProblem('unsafe_path', 'Родитель не является каталогом');
    }
  }

  stamp(path: string): string {
    if (!path) {
      this.checkRoot();
      return fileStamp(lstatSync(this.root, { bigint: true }));
    }
    const stat = lstatSync(this.absolute(path), { bigint: true });
    if (!stat.isFile()) throw new DocumentProblem('unsafe_path', 'Ожидался обычный файл');
    return fileStamp(stat);
  }

  readBytes(path: string): { bytes: Buffer; mtimeMs: number; birthtimeMs: number; stamp: string } {
    const absolute = this.absolute(path);
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile()) throw new DocumentProblem('unsafe_path', 'Ожидался обычный файл');
      const bytes = readFileSync(fd);
      const stamp = fileStamp(before);
      const after = fstatSync(fd, { bigint: true });
      if (fileStamp(after) !== stamp || this.stamp(path) !== stamp) {
        throw new DocumentProblem('unreadable_file', 'Файл изменился во время чтения');
      }
      return { bytes, stamp, mtimeMs: Number(after.mtimeNs) / 1e6, birthtimeMs: Number(after.birthtimeNs) / 1e6 };
    } finally { closeSync(fd); }
  }
  read(path: string): { source: string; mtimeMs: number; birthtimeMs: number } {
    const { bytes, mtimeMs, birthtimeMs } = this.readBytes(path);
    return { source: decodeVaultText(bytes), mtimeMs, birthtimeMs };
  }
  optionalBytes(path: string): Buffer | null {
    try { return this.readBytes(path).bytes; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  optional(path: string): string | null {
    try { return this.read(path).source; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private refreshIgnore(): void {
    let bytes: Buffer;
    try {
      const stamp = this.stamp(ignoreFile);
      if (stamp === this.ignoreStamp) return;
      const read = this.readBytes(ignoreFile);
      this.ignoreStamp = read.stamp;
      bytes = read.bytes;
    } catch (error) {
      this.ignoreStamp = null;
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        if (this.ignoreRules.size) this.ignoreRules = new Set();
        this.ignoreProblem = undefined;
      } else if (error instanceof Error && 'code' in error) {
        this.ignoreProblem = { path: ignoreFile, code: 'unreadable_file', message: 'Не удалось прочитать .livenoteignore' };
      } else throw error;
      return;
    }
    try {
      this.ignoreRules = parseIgnoredDirectories(decodeVaultText(bytes));
      this.ignoreProblem = undefined;
    } catch (error) {
      if (!(error instanceof DocumentProblem)) throw error;
      this.ignoreProblem = { path: ignoreFile, code: error.code, message: error.message };
    }
  }

  assertAuthorable(entries: Iterable<{ readonly path: string; readonly directory: boolean }>): void {
    this.refreshIgnore();
    if (this.ignoreProblem) throw new InvalidRequestError(this.ignoreProblem.message);
    for (const { path, directory } of entries) {
      const parts = path.normalize('NFC').split('/');
      if (parts[0]?.toLowerCase() === ignoreFile || ignoredPath(this.ignoreRules, path, directory)) {
        throw new InvalidRequestError('Запись в скрытый или служебный путь запрещена', { path });
      }
      if (!directory) parts.pop();
      const parent = parts.join('/');
      for (const rule of this.ignoreRules) {
        const prefix = parent.slice(0, rule.length);
        if (prefix.toLowerCase() !== rule.toLowerCase() || (parent.length !== rule.length && parent[rule.length] !== '/')) continue;
        // На файловой системе без учёта регистра другой регистр может указывать на скрытый каталог.
        const candidate = lstatSync(this.absolute(prefix), { bigint: true, throwIfNoEntry: false });
        const hidden = lstatSync(this.absolute(rule), { bigint: true, throwIfNoEntry: false });
        if (candidate?.isDirectory() && hidden?.isDirectory() && candidate.dev === hidden.dev && candidate.ino === hidden.ino) {
          throw new InvalidRequestError('Запись в скрытый каталог запрещена', { path });
        }
      }
    }
  }

  list(directory = '', includeOperational = false) {
    if (!includeOperational) this.refreshIgnore();
    const rules = this.ignoreRules;
    const files: string[] = [];
    const folders: string[] = [directory];
    const ignoredFolders: string[] = [];
    const hiddenEntries: string[] = [];
    const problems: VaultProblem[] = !includeOperational && this.ignoreProblem ? [this.ignoreProblem] : [];
    const walk = (path: string): void => {
      let entries;
      try { this.checkRoot(); entries = readdirSync(path ? this.absolute(path) : this.root, { withFileTypes: true }); }
      catch (error) {
        problems.push({ code: error instanceof DocumentProblem ? error.code : 'unreadable_file', path, message: error instanceof DocumentProblem ? error.message : 'Каталог недоступен' });
        return;
      }
      for (const entry of entries) {
        const child = path ? path + '/' + entry.name : entry.name;
        if (!includeOperational) {
          if (child === ignoreFile) continue;
          if (['.git', '.livenote'].includes(entry.name)) { hiddenEntries.push(child); continue; }
          if (entry.isDirectory() && ignoredPath(rules, child, true)) {
            ignoredFolders.push(child);
            hiddenEntries.push(child);
            continue;
          }
        }
        if (entry.isSymbolicLink()) { problems.push({ code: 'unsafe_path', path: child, message: 'Символическая ссылка запрещена' }); continue; }
        if (entry.isDirectory()) { folders.push(child); walk(child); }
        else if (entry.isFile()) files.push(child);
      }
    };
    walk(directory);
    return { files: files.sort(), folders: folders.sort(), problems, ignoredFolders, hiddenEntries, rules };
  }

  private syncDirectory(path: string): void {
    const fd = openSync(path, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private writeExclusive(path: string, source: string | Buffer): void {
    this.parents(path);
    const fd = openSync(this.absolute(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, source, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    this.syncDirectory(dirname(this.absolute(path)));
  }

  private same(actual: string | Buffer | null, encoded: string | null): boolean {
    return actual === null ? encoded === null : encoded !== null && sha256(actual) === sha256(Buffer.from(encoded, 'base64'));
  }

  /** Журнал содержит старые/новые байты, fsync предшествует первой публикации. */
  commit(writes: FileWrite[], directories: DirectoryChange[] = [], rename?: PathRename): boolean {
    const targets = [
      ...writes.filter(write => !write.path.startsWith('.livenote/requests/')).map(write => ({ path: write.path, directory: false })),
      ...directories.map(entry => ({ path: entry.path, directory: true })),
    ];
    const removed = new Set(directories.filter(entry => !entry.next).map(entry => entry.path));
    for (const path of removed) {
      if (removed.has(dirname(path))) continue;
      const scan = this.list(path);
      if (scan.hiddenEntries.length || scan.problems.length) throw new InvalidRequestError('Папка содержит скрытые или недоступные пути', { path });
    }
    if (rename) {
      const directory = lstatSync(this.absolute(rename.from)).isDirectory();
      targets.push({ path: rename.from, directory }, { path: rename.to, directory });
      if (directory) {
        const scan = this.list(rename.from);
        if (scan.hiddenEntries.length || scan.problems.length) throw new InvalidRequestError('Папка содержит скрытые или недоступные пути');
        targets.push(...scan.folders.map(path => ({ path: rename.to + path.slice(rename.from.length), directory: true })));
      }
    }
    if (targets.length) this.assertAuthorable(targets);
    const changes: Change[] = [];
    for (const write of writes) {
      const originalPath = rename && (write.path === rename.to || write.path.startsWith(rename.to + '/')) ? rename.from + write.path.slice(rename.to.length) : write.path;
      const actual = this.optionalBytes(originalPath);
      const equal = (value: string | Buffer | null): boolean => actual === null ? value === null : value !== null && actual.equals(Buffer.from(value));
      if (!equal(write.expected)) throw new AppError('conflict', 'Файл изменён перед публикацией', 409, { currentRevision: 0, reason: 'stale', paths: [write.path] });
      if (equal(write.source)) continue;
      changes.push({
        path: write.path, old: actual === null ? null : Buffer.from(actual).toString('base64'),
        next: write.source === null ? null : Buffer.from(write.source).toString('base64'),
        oldHash: actual === null ? null : sha256(actual), newHash: write.source === null ? null : sha256(write.source)
      });
    }
    const directoryMap = new Map(directories.map(entry => [entry.path, entry]));
    for (const write of writes.filter(write => write.source !== null)) {
      const parts = write.path.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/');
        const original = rename && (path === rename.to || path.startsWith(rename.to + '/')) ? rename.from + path.slice(rename.to.length) : path;
        if (!existsSync(this.absolute(original)) && !directoryMap.has(path)) directoryMap.set(path, { path, old: false, next: true });
      }
    }
    const directoryChanges = [...directoryMap.values()];
    for (const entry of directoryChanges) {
      const absolute = this.absolute(entry.path);
      if (existsSync(absolute) !== entry.old || (entry.old && !lstatSync(absolute).isDirectory())) throw new AppError('conflict', 'Каталог изменился', 409, { currentRevision: 0, reason: 'stale', paths: [entry.path] });
    }
    if (!changes.length && !directoryChanges.length && !rename) return false;
    const journal: Journal = { id: randomUUID(), changes, directories: directoryChanges, ...(rename ? { rename } : {}) };
    const directory = `.livenote/transactions/${journal.id}`;
    this.writeExclusive(directory + '/journal.json', JSON.stringify(journal));
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i]!;
      if (change.next !== null) this.writeExclusive(`${directory}/new-${i}`, Buffer.from(change.next, 'base64'));
    }
    for (const change of changes) {
      if (!this.same(this.optionalBytes(this.currentPath(journal, change.path)), change.old)) {
        this.quarantine(journal);
        throw new AppError('conflict', 'Внешнее изменение; сохранён журнал восстановления', 409, { currentRevision: 0, reason: 'transaction_incomplete', paths: changes.map(c => c.path) });
      }
    }
    try {
      this.applyRename(journal);
      for (const entry of directoryChanges.filter(entry => entry.next).sort((a, b) => a.path.length - b.path.length)) {
        this.parents(entry.path);
        if (!entry.old) mkdirSync(this.absolute(entry.path));
      }
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i]!;
        if (!this.same(this.optionalBytes(change.path), change.old)) throw new Error('Файл изменён во время транзакции');
        this.parents(change.path);
        const destination = this.absolute(change.path);
        if (change.next === null) unlinkSync(destination);
        else renameSync(this.absolute(`${directory}/new-${i}`), destination);
        this.syncDirectory(dirname(destination));
      }
      for (const entry of directoryChanges.filter(entry => !entry.next).sort((a, b) => b.path.length - a.path.length)) rmdirSync(this.absolute(entry.path));
    } catch {
      this.quarantine(journal);
      throw new AppError('conflict', 'Транзакция не завершена; сохранено восстановление', 409, { currentRevision: 0, reason: 'transaction_incomplete', paths: changes.map(c => c.path) });
    }
    rmSync(this.absolute(directory), { recursive: true });
    this.syncDirectory(dirname(this.absolute(directory)));
    return true;
  }

  private exactExists(path: string): boolean {
    const absolute = this.absolute(path);
    try { return readdirSync(dirname(absolute)).includes(path.split('/').at(-1) ?? ''); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private renameLocation(journal: Journal): string | undefined {
    if (!journal.rename) return undefined;
    const staged = `.livenote/transactions/${journal.id}/renamed`;
    if (existsSync(this.absolute(staged))) return staged;
    if (this.exactExists(journal.rename.to)) return journal.rename.to;
    if (this.exactExists(journal.rename.from)) return journal.rename.from;
    throw new InvalidRequestError('Путь незавершённого переименования отсутствует');
  }
  private currentPath(journal: Journal, path: string): string {
    const rename = journal.rename;
    if (!rename || (path !== rename.to && !path.startsWith(rename.to + '/'))) return path;
    return (this.renameLocation(journal) ?? rename.to) + path.slice(rename.to.length);
  }
  private applyRename(journal: Journal): void {
    const rename = journal.rename; if (!rename) return;
    let location = this.renameLocation(journal);
    if (location === rename.to) return;
    if (this.exactExists(rename.to)) throw new InvalidRequestError('Назначение переименования уже существует');
    const staged = `.livenote/transactions/${journal.id}/renamed`;
    if (location === rename.from) { renameSync(this.absolute(rename.from), this.absolute(staged)); location = staged; }
    if (location !== staged) throw new InvalidRequestError('Некорректное состояние переименования');
    renameSync(this.absolute(staged), this.absolute(rename.to));
    this.syncDirectory(dirname(this.absolute(rename.to)));
  }

  private quarantine(journal: Journal): void {
    for (const change of journal.changes.filter(c => c.path.endsWith('.md') || c.path.startsWith('_assets/'))) {
      if (!this.recoveryProblems.some(problem => problem.path === change.path)) {
        this.recoveryProblems.push({ code: 'unreadable_file', path: change.path, message: `Незавершённая транзакция ${journal.id}; сохраните конфликтующие версии и восстановите вручную` });
      }
    }
  }

  private recover(): void {
    const directory = this.absolute('.livenote/transactions');
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new InvalidRequestError('Небезопасный журнал транзакций');
      const journalPath = `.livenote/transactions/${entry.name}/journal.json`;
      let journal: Journal;
      try {
        journal = JSON.parse(this.read(journalPath).source) as Journal;
        if (journal.id !== entry.name || !Array.isArray(journal.changes) || (!journal.changes.length && !journal.directories?.length && !journal.rename)) throw new Error();
        if (journal.rename) { this.absolute(journal.rename.from); this.absolute(journal.rename.to); }
        for (const directory of journal.directories ?? []) {
          this.absolute(directory.path);
          if (typeof directory.old !== 'boolean' || typeof directory.next !== 'boolean') throw new Error();
        }
        for (const change of journal.changes) {
          this.absolute(change.path);
          if ((change.old !== null && typeof change.old !== 'string') || (change.next !== null && typeof change.next !== 'string')) throw new Error();
          if ((change.old === null ? null : sha256(Buffer.from(change.old, 'base64'))) !== change.oldHash ||
              (change.next === null ? null : sha256(Buffer.from(change.next, 'base64'))) !== change.newHash) throw new Error();
        }
      } catch { throw new InvalidRequestError('Повреждён журнал восстановления'); }
      if (journal.changes.some(change => {
        const actual = this.optionalBytes(this.currentPath(journal, change.path));
        return !this.same(actual, change.old) && !this.same(actual, change.next);
      })) { this.quarantine(journal); continue; }
      this.applyRename(journal);
      for (const directory of (journal.directories ?? []).filter(directory => directory.next).sort((a, b) => a.path.length - b.path.length)) {
        this.parents(directory.path);
        if (!existsSync(this.absolute(directory.path))) mkdirSync(this.absolute(directory.path));
      }
      for (let i = 0; i < journal.changes.length; i++) {
        const change = journal.changes[i]!;
        if (this.same(this.optionalBytes(change.path), change.next)) continue;
        if (!this.same(this.optionalBytes(change.path), change.old)) { this.quarantine(journal); break; }
        this.parents(change.path);
        if (change.next === null) unlinkSync(this.absolute(change.path));
        else {
          const staged = `.livenote/transactions/${entry.name}/recover-${i}-${randomUUID()}`;
          this.writeExclusive(staged, Buffer.from(change.next, 'base64'));
          if (!this.same(this.optionalBytes(change.path), change.old)) { this.quarantine(journal); break; }
          renameSync(this.absolute(staged), this.absolute(change.path));
        }
        this.syncDirectory(dirname(this.absolute(change.path)));
      }
      if (!this.recoveryProblems.some(p => journal.changes.some(c => c.path === p.path))) {
        for (const directory of (journal.directories ?? []).filter(directory => !directory.next).sort((a, b) => b.path.length - a.path.length)) {
          try { rmdirSync(this.absolute(directory.path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        rmSync(this.absolute(`.livenote/transactions/${entry.name}`), { recursive: true });
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.optional('.livenote/lock') === this.lockIdentity) unlinkSync(this.absolute('.livenote/lock'));
  }
}
