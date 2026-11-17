// allow: SIZE_OK — единый PageStore владеет синхронной проекцией, CAS и deferred transaction; предел задачи 600 строк.
import { randomUUID } from 'node:crypto';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { posix } from 'node:path';
import type { BlockType, Broadcaster, CreatePageBody, MoveVaultPageBody, PageFull, PatchVaultMetadataBody, UpdatePagePatch, VaultDocument, VaultMoveResult, VaultProblem, VaultSearchHit, VaultSnapshot, WriteVaultDocumentBody } from '../shared/types.js';
import type { NewBlock } from './db.js';
import { AppError, IdempotencyKeyError, InvalidRequestError, NotFoundError } from './errors.js';
import type { PageStore } from './store.js';
import { applyEdits, blockContent, diagramFormat, DocumentProblem, fileVersion, markdownProse, openable, parseVaultDocument, relativeUrl, safeTitle, sha256, type ParsedVaultDocument } from './vaultDocument.js';
import { VaultFiles, validateNotePath, validateVaultPath, type DirectoryChange, type FileWrite } from './vaultFiles.js';
import { folded, publicLinks, resolveLinks, rewritePaths, type LinkSpan } from './vaultLinks.js';
import { vaultZip } from './vaultExport.js';

export interface PreparedDocument {
  previous: ParsedVaultDocument; next: ParsedVaultDocument; body: WriteVaultDocumentBody;
  assets: Map<string, string>; assetExpected: Map<string, string | null>; references: Map<string, string | null>;
}
/** Файлы авторитетны; maps содержат только пересоздаваемую проекцию. */
export class VaultStore implements PageStore {
  readonly files: VaultFiles;
  changedPages: Array<{ id: string; revision: number }> = [];
  private pages = new Map<string, ParsedVaultDocument>();
  private problems: VaultProblem[] = [];
  private links = new Map<string, LinkSpan[]>();
  private renders = new Map<string, { revision: number; ok: boolean; error: string | null }>();
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private closed = false;
  private deferred: FileWrite[] | null = null;
  private lastTree = '';
  constructor(path: string, private readonly broadcaster?: Broadcaster) {
    this.files = new VaultFiles(path);
    try {
      this.reconcile(false); this.cleanupIdempotency(86_400_000);
      this.watcher = watch(this.files.root, { recursive: true }, (_event, filename) => {
        if (filename && String(filename).startsWith('.livenote')) return;
        clearTimeout(this.debounce); this.debounce = setTimeout(() => this.reconcile(true), 60); this.debounce.unref();
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
      this.timer = setInterval(() => this.reconcile(true), 1000); this.timer.unref();
    } catch (error) { this.files.close(); throw error; }
  }
  private read(path: string) {
    const staged = this.deferred?.findLast(write => write.path === path);
    if (staged) {
      if (staged.source === null) throw Object.assign(new Error('Нет файла'), { code: 'ENOENT' });
      return { source: staged.source.toString(), mtimeMs: 0, birthtimeMs: 0 };
    }
    return this.files.read(path);
  }
  private optionalSource(path: string): string | null {
    try { return this.read(path).source; } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  reconcile(external = true): void {
    if (this.closed) return;
    const previous = this.pages; const scan = this.files.list();
    const paths = new Set(scan.files.filter(openable));
    for (const write of this.deferred ?? []) if (openable(write.path) && !write.path.startsWith('.livenote/')) {
      if (write.source === null) paths.delete(write.path); else paths.add(write.path);
    }
    const next = new Map<string, ParsedVaultDocument>(); const problems = [...scan.problems, ...this.files.recoveryProblems];
    for (const path of paths) {
      if (this.files.recoveryProblems.some(problem => problem.path === path)) continue;
      try {
        const note = this.read(path); const parsed = parseVaultDocument(note.source, path, asset => this.read(asset), note);
        next.set(path, parsed); problems.push(...parsed.problems);
      } catch (error) {
        problems.push({ code: error instanceof DocumentProblem ? error.code : 'unreadable_file', path, pageId: path, message: error instanceof Error ? error.message : 'Документ недоступен' });
      }
    }
    this.pages = next; this.problems = problems; this.links.clear();
    const documents = [...next.values()].map(item => item.document);
    for (const [id, parsed] of next) {
      const links = resolveLinks(parsed.document, documents, 0, scan.files);
      this.links.set(id, links); parsed.document.links = publicLinks(links);
      parsed.document.backlinks = documents.filter(other => other.path !== id && resolveLinks(other, documents, 0, scan.files).some(link => link.targetPageId === id))
        .map(other => ({ pageId: other.path, path: other.path, title: other.page.title })).sort((a, b) => a.path.localeCompare(b.path));
      for (const block of parsed.document.page.blocks) {
        const render = this.renders.get(id + '\0' + parsed.document.page.revision + '\0' + block.id);
        if (render) { block.renderedRevision = render.revision; block.renderOk = render.ok; block.renderError = render.error; }
      }
    }
    const tree = this.treeVersion();
    if (external && !this.deferred) {
      for (const [id, parsed] of next) if (previous.get(id)?.document.version !== parsed.document.version) this.broadcaster?.publish({ event: previous.has(id) ? 'page.updated' : 'page.created', pageId: id, revision: parsed.document.page.revision, origin: 'external', ts: Date.now() });
      for (const [id, parsed] of previous) if (!next.has(id)) this.broadcaster?.publish({ event: 'page.deleted', pageId: id, revision: parsed.document.page.revision, origin: 'external', ts: Date.now() });
      if (this.lastTree && tree !== this.lastTree) this.broadcaster?.publish({ event: 'vault.updated', pageId: '', revision: 0, origin: 'external', ts: Date.now() });
    }
    this.lastTree = tree;
  }
  private treeVersion(): string {
    const scan = this.files.list();
    return fileVersion(JSON.stringify([scan.folders, scan.files.map(path => {
      try { return [path, fileVersion(this.files.readBytes(path).bytes)]; }
      catch (error) {
        if (error instanceof DocumentProblem) return [path, error.code];
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [path, 'missing'];
        throw error;
      }
    })]));
  }
  snapshot(): VaultSnapshot {
    this.reconcile();
    const documents = [...this.pages.values()].map(item => item.document).sort((a, b) => a.path.localeCompare(b.path));
    const pages = documents.filter(d => d.path.endsWith('.md')).map(d => ({ id: d.path, title: d.page.title, revision: d.page.revision, createdAt: d.page.createdAt, updatedAt: d.page.updatedAt, path: d.path, aliases: d.aliases, tags: d.tags }));
    const tags = new Map<string, number>(); for (const page of pages) for (const tag of page.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    return { pages, files: documents.map(d => ({ path: d.path, title: d.page.title, version: d.version, revision: d.page.revision, kind: diagramFormat(d.path) ?? 'markdown' })),
      folders: this.files.list().folders, treeVersion: this.treeVersion(), tags: [...tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag)), problems: this.problems };
  }
  listPages() { return this.snapshot().pages; }
  exportArchive(): Buffer {
    const scan = this.files.list();
    if (scan.problems.length) throw new InvalidRequestError('Небезопасный файл в экспорте', scan.problems);
    return vaultZip([...scan.folders.filter(Boolean).map(path => ({ path: path + '/', bytes: Buffer.alloc(0) })), ...scan.files.map(path => ({ path, bytes: this.files.readBytes(path).bytes }))]);
  }
  getPage(id: string): PageFull | undefined { this.reconcile(); validateNotePath(id); return this.pages.get(id)?.document.page; }
  document(id: string): VaultDocument { validateNotePath(id); this.reconcile(); return this.require(id).document; }
  private require(id: string): ParsedVaultDocument {
    const parsed = this.pages.get(id);
    if (parsed) return parsed;
    const problems = this.problems.filter(problem => problem.path === id);
    if (problems.length) throw new AppError('conflict', 'Документ требует исправления', 409, { currentRevision: 0, reason: 'document_problem', paths: [id], problems });
    throw new NotFoundError('Документ не найден', { pageId: id });
  }
  check(id: string, revision: number, version?: string): ParsedVaultDocument {
    validateNotePath(id); this.reconcile();
    if (!this.pages.has(id) && !this.problems.some(problem => problem.path === id)) throw new AppError('conflict', 'Документ удалён', 409, { currentRevision: 0, reason: 'missing', paths: [id] });
    const current = this.require(id);
    if (current.document.page.revision !== revision || (version !== undefined && current.document.version !== version)) this.conflict([id], current.document);
    return current;
  }
  private conflict(paths: string[], document?: VaultDocument): never {
    throw new AppError('conflict', 'Файлы изменились; перечитайте документ', 409, { currentRevision: document?.page.revision ?? 0, currentVersion: document?.version, currentTreeVersion: this.treeVersion(), reason: 'stale', paths });
  }
  private parse(source: string, path: string, assets = new Map<string, string>()): ParsedVaultDocument {
    try { return parseVaultDocument(source, path, asset => assets.has(asset) ? { source: assets.get(asset) ?? '' } : this.read(asset)); }
    catch (error) { if (error instanceof DocumentProblem) throw new InvalidRequestError(error.message, { code: error.code, path }); throw error; }
  }
  private publish(writes: FileWrite[], guards: ParsedVaultDocument[] = [], directories: DirectoryChange[] = []): void {
    for (const guard of guards) this.check(guard.document.path, guard.document.page.revision, guard.document.version);
    const before = new Map([...this.pages].map(([id, item]) => [id, item.document.version]));
    if (this.deferred) for (const write of writes) { const prior = this.deferred.find(entry => entry.path === write.path); if (prior) prior.source = write.source; else this.deferred.push(write); }
    else this.files.commit(writes, directories);
    this.reconcile(false);
    this.changedPages = [...this.pages].filter(([id, item]) => before.get(id) !== item.document.version).map(([id, item]) => ({ id, revision: item.document.page.revision }));
  }
  private destinationFree(path: string, except?: string): void {
    validateVaultPath(path); const scan = this.files.list();
    const parents = path.split('/').slice(0, -1).map((_, index) => path.split('/').slice(0, index + 1).join('/'));
    if (parents.some(parent => scan.folders.some(folder => folded(folder) === folded(parent) && folder !== parent)) ||
        [...scan.files, ...scan.folders].some(other => other !== except && folded(other) === folded(path)) || (path !== except && existsSync(this.files.absolute(path)))) {
      throw new AppError('conflict', 'Назначение уже существует', 409, { currentRevision: 0, reason: 'destination_exists', paths: [path] });
    }
  }
  inspectCreation(body: CreatePageBody): ParsedVaultDocument {
    const path = body.path ?? safeTitle(body.title) + '.' + (body.format === 'mermaid' ? 'mmd' : body.format ?? 'md');
    validateNotePath(path);
    return this.parse(body.source ?? '', path);
  }
  createPage(title: string, options: Partial<CreatePageBody> = {}): PageFull {
    if (options.aliases !== undefined || options.tags !== undefined) throw new InvalidRequestError('Метаданные задаются в source заметки');
    let path = options.path ?? `${safeTitle(title)}.${options.format === 'mermaid' ? 'mmd' : options.format ?? 'md'}`;
    if (!options.path) { let n = 2; const original = path; while (existsSync(this.files.absolute(path)) || this.deferred?.some(write => write.path === path && write.source !== null)) path = original.slice(0, -posix.extname(original).length) + ' ' + n++ + posix.extname(original); }
    validateNotePath(path);
    if (options.format !== undefined && diagramFormat(path) !== options.format) throw new InvalidRequestError('format не соответствует расширению');
    if (diagramFormat(path) && options.source === undefined) throw new InvalidRequestError('Для диаграммы требуется source');
    this.destinationFree(path); const source = options.source ?? '';
    if (typeof source !== 'string' || Buffer.from(source).toString() !== source) throw new InvalidRequestError('Некорректный UTF-8 source');
    this.parse(source, path); this.publish([{ path, source, expected: null }]); return this.require(path).document.page;
  }
  createPageWithBlocks(title: string, blocks: NewBlock[]): PageFull {
    return this.transaction(() => {
      let page = this.createPage(title);
      for (const block of blocks) page = this.upsertBlock(page.id, undefined, block.type, block.source, page.revision, block.title).page;
      return page;
    });
  }
  prepare(id: string, body: WriteVaultDocumentBody): PreparedDocument {
    if (typeof body.source !== 'string' || typeof body.expectedVersion !== 'string' || !Number.isSafeInteger(body.expectedRevision) || Buffer.from(body.source).toString() !== body.source) throw new InvalidRequestError('Требуются корректные source, expectedRevision, expectedVersion');
    const previous = this.check(id, body.expectedRevision, body.expectedVersion);
    const assets = new Map<string, string>(); const assetExpected = new Map<string, string | null>(); const references = new Map<string, string | null>();
    if (body.assets !== undefined && !Array.isArray(body.assets)) throw new InvalidRequestError('assets должен быть массивом');
    if (body.references !== undefined && !Array.isArray(body.references)) throw new InvalidRequestError('references должен быть массивом');
    for (const entry of body.assets ?? []) {
      validateVaultPath(entry.path);
      if (!diagramFormat(entry.path) || assets.has(entry.path) || typeof entry.source !== 'string' || Buffer.from(entry.source).toString() !== entry.source || (entry.expectedVersion !== null && typeof entry.expectedVersion !== 'string')) throw new InvalidRequestError('Некорректный asset');
      const old = this.optionalSource(entry.path);
      if ((old === null ? null : fileVersion(old)) !== entry.expectedVersion) this.conflict([entry.path], previous.document);
      if (old === null) this.destinationFree(entry.path);
      assets.set(entry.path, entry.source); assetExpected.set(entry.path, old);
    }
    if (diagramFormat(id) && assets.size) throw new InvalidRequestError('Standalone diagram не принимает assets');
    const next = this.parse(body.source, id, assets);
    for (const path of assets.keys()) if (!next.document.assets.some(asset => asset.path === path)) throw new InvalidRequestError('Asset должен быть встроен в документ');
    for (const entry of body.references ?? []) {
      validateVaultPath(entry.path);
      if (typeof entry.expectedVersion !== 'string' || references.has(entry.path) || !next.document.assets.some(asset => asset.path === entry.path)) throw new InvalidRequestError('Некорректная reference');
      const old = this.optionalSource(entry.path);
      if (old === null || fileVersion(old) !== entry.expectedVersion) this.conflict([entry.path], previous.document);
      references.set(entry.path, old);
    }
    for (const asset of next.document.assets) if (!assets.has(asset.path)) references.set(asset.path, asset.source);
    return { previous, next, body, assets, assetExpected, references };
  }
  finish(id: string, prepared: PreparedDocument): VaultDocument {
    this.check(id, prepared.body.expectedRevision, prepared.body.expectedVersion);
    for (const [path, source] of prepared.references) if (this.optionalSource(path) !== source) this.conflict([path], prepared.previous.document);
    const writes: FileWrite[] = [{ path: id, expected: prepared.previous.document.source, source: prepared.next.document.source }];
    for (const [path, source] of prepared.assets) writes.push({ path, source, expected: prepared.assetExpected.get(path) ?? null });
    this.publish(writes, [prepared.previous]); return this.require(id).document;
  }
  metadata(id: string, body: PatchVaultMetadataBody): VaultDocument {
    this.check(id, body.expectedRevision, body.expectedVersion);
    if (body.aliases !== undefined || body.tags !== undefined) throw new InvalidRequestError('Редактируйте aliases в YAML и #теги в исходнике');
    if (body.title === undefined) throw new InvalidRequestError('Требуется title');
    const path = posix.join(posix.dirname(id), safeTitle(body.title) + posix.extname(id));
    return this.move(id, { ...body, path }).document ?? this.document(id);
  }
  upsertBlock(id: string, blockId: string | undefined, type: BlockType, content: string, revision: number, title?: string | null, at?: number) {
    const previous = this.check(id, revision); const existing = blockId === undefined ? undefined : previous.spans.find(span => span.id === blockId);
    if (blockId !== undefined && !existing) throw new NotFoundError('Блок не найден в текущей ревизии', { blockId });
    const old = existing ? previous.document.page.blocks[previous.spans.indexOf(existing)] : undefined;
    if (old?.type === type && old.source === content && (title === undefined || old.title === title)) return { page: previous.document.page, created: false, blockId: old.id };
    let source = previous.document.source;
    const assets: NonNullable<WriteVaultDocumentBody['assets']> = [];
    let replacement = content;
    if (diagramFormat(id)) {
      if (diagramFormat(id) !== type) throw new InvalidRequestError('Нельзя менять тип standalone diagram');
    } else if (existing?.assetPath && old?.type === type) {
      const asset = previous.document.assets.find(asset => asset.path === existing.assetPath);
      assets.push({ path: existing.assetPath, source: content, expectedVersion: asset?.version ?? null }); replacement = source.slice(existing.start, existing.end);
      if (title !== undefined) {
        const label = title ?? '';
        replacement = replacement.startsWith('![[') ? replacement.replace(/^!\[\[([^|\]]+)(?:\|[^\]]*)?\]\]$/, `![[$1|${label}]]`)
          : replacement.replace(/^!\[(?:\\.|[^\]])*\]/, '![' + label.replace(/[\[\]\\]/g, '\\$&') + ']');
      }
    } else {
      let assetPath: string | undefined;
      if (type === 'bpmn' || type === 'drawio') {
        const base = posix.join(posix.dirname(id), 'Схемы', safeTitle(previous.document.page.title + ' — ' + (title || type)));
        assetPath = base + '.' + type; let n = 2;
        while (existsSync(this.files.absolute(assetPath)) || this.deferred?.some(write => write.path === assetPath && write.source !== null)) assetPath = base + ' ' + n++ + '.' + type;
        assets.push({ path: assetPath, source: content, expectedVersion: null });
      }
      replacement = blockContent(type, content, previous.newline, assetPath ? relativeUrl(id, assetPath) : undefined, title);
      if (type === 'mermaid' && title) replacement = '## ' + title + previous.newline + replacement;
    }
    const start = existing?.start ?? at ?? source.length; const end = existing?.end ?? start;
    if (!Number.isSafeInteger(start) || start < 0 || start > source.length || (!existing && previous.spans.some(span => span.type !== 'markdown' && start > span.start && start < span.end))) throw new InvalidRequestError('Некорректная позиция at');
    if (!existing && start > 0 && source[start - 1] !== '\n') replacement = previous.newline + replacement;
    if (!existing && start < source.length && !replacement.endsWith('\n')) replacement += previous.newline;
    source = applyEdits(source, [{ start, end, value: replacement }]);
    const next = this.prepare(id, { expectedRevision: revision, expectedVersion: previous.document.version, source, assets });
    const page = this.finish(id, next).page;
    const derived = this.require(id).spans.find(span => span.start <= start && span.end >= start + replacement.length) ?? this.require(id).spans.find(span => span.type === type && span.start >= start);
    return { page, created: !existing, blockId: derived?.id ?? page.blocks[0]?.id ?? '' };
  }
  updatePage(id: string, patch: UpdatePagePatch, revision: number): PageFull {
    const before = this.check(id, revision); const removed = new Set(patch.deleteBlockIds ?? []);
    for (const blockId of removed) if (!before.spans.some(span => span.id === blockId)) throw new NotFoundError('Блок не найден', { blockId });
    const remaining = before.spans.filter(span => !removed.has(span.id)); const order = patch.blockOrder ?? remaining.map(span => span.id);
    if (order.length !== remaining.length || new Set(order).size !== remaining.length || order.some(id => !remaining.some(span => span.id === id))) throw new InvalidRequestError('Некорректный blockOrder');
    const source = order.map(id => { const span = remaining.find(span => span.id === id); return span ? before.document.source.slice(span.start, span.end) : ''; }).join('');
    const path = patch.title === undefined ? id : posix.join(posix.dirname(id), safeTitle(patch.title) + posix.extname(id));
    if (path !== id) {
      const moved = this.movePaths(id, path, { folder: false, source });
      if (!moved.document) throw new NotFoundError('Документ после перемещения отсутствует');
      return moved.document.page;
    }
    return this.finish(id, this.prepare(id, { expectedRevision: revision, expectedVersion: before.document.version, source })).page;
  }
  deleteBlock(id: string, blockId: string, revision: number): PageFull { return this.updatePage(id, { deleteBlockIds: [blockId] }, revision); }
  softDeletePage(id: string, revision: number): void {
    const before = this.check(id, revision); const directory = '.livenote/trash/' + randomUUID();
    this.publish([{ path: directory + '/' + id, source: before.document.source, expected: null }, { path: id, source: null, expected: before.document.source }], [before]);
  }
  private checkTree(version: string): void { if (typeof version !== 'string' || version !== this.treeVersion()) this.conflict([]); }
  createFolder(path: string, version: string): VaultSnapshot {
    this.checkTree(version); validateVaultPath(path); this.destinationFree(path);
    const parts = path.split('/'); const directories = parts.map((_, i) => parts.slice(0, i + 1).join('/')).filter(path => !existsSync(this.files.absolute(path))).map(path => ({ path, old: false, next: true }));
    this.checkTree(version); this.publish([], [], directories); return this.snapshot();
  }
  move(id: string, body: MoveVaultPageBody): VaultMoveResult {
    this.check(id, body.expectedRevision, body.expectedVersion); validateNotePath(body.path);
    if (diagramFormat(id) !== diagramFormat(body.path)) throw new InvalidRequestError('Расширение должно сохранять формат');
    return this.movePaths(id, body.path, { folder: false });
  }
  moveFolder(from: string, path: string, version: string): VaultMoveResult { this.checkTree(version); return this.movePaths(from, path, { folder: true, version }); }
  private movePaths(from: string, path: string, options: { folder: boolean; source?: string; version?: string }): VaultMoveResult {
    const { folder } = options;
    validateVaultPath(from); validateVaultPath(path);
    if (folder && path.startsWith(from + '/')) throw new InvalidRequestError('Нельзя переместить папку внутрь себя');
    const scan = this.files.list();
    if (folder && !scan.folders.includes(from)) throw new NotFoundError('Папка не найдена');
    if (from === path) return { ...(folder ? {} : { document: this.document(from) }), moved: [], updatedPaths: [], treeVersion: this.treeVersion() };
    const caseOnly = folded(from) === folded(path);
    if (!caseOnly) this.destinationFree(path, from);
    else if ([...scan.files, ...scan.folders].includes(path)) this.destinationFree(path, from);
    const selected = scan.files.filter(file => file === from || (folder && file.startsWith(from + '/')));
    const folders = folder ? scan.folders.filter(dir => dir === from || dir.startsWith(from + '/')) : [];
    if (scan.problems.some(problem => problem.path === from || problem.path.startsWith(from + '/'))) throw new InvalidRequestError('Небезопасное дерево');
    const mapping = new Map([...selected, ...folders].map(old => [old, path + old.slice(from.length)]));
    const writes: FileWrite[] = []; const guards: ParsedVaultDocument[] = []; const updatedPaths: string[] = [];
    const previous = new Map([...this.pages].map(([id, item]) => [id, item.document.version]));
    for (const file of scan.files) {
      const parsed = this.pages.get(file); const to = mapping.get(file) ?? file; const bytes = this.files.readBytes(file).bytes;
      const candidate = file === from && options.source !== undefined ? this.parse(options.source, file).document : parsed?.document;
      const links = candidate && candidate !== parsed?.document ? resolveLinks(candidate, [...this.pages.values()].map(item => item.document), 0, scan.files) : this.links.get(file) ?? [];
      const source = candidate && file.endsWith('.md') ? rewritePaths(candidate, links, mapping) : bytes;
      if (to === file && (typeof source !== 'string' || source === parsed?.document.source)) continue;
      if (caseOnly && to !== file) {
        if (typeof source === 'string' && source !== parsed?.document.source) writes.push({ path: to, expected: bytes, source });
      } else {
        if (to !== file) writes.push({ path: file, expected: bytes, source: null });
        writes.push({ path: to, expected: to === file ? bytes : null, source });
      }
      updatedPaths.push(to); if (parsed) guards.push(parsed);
    }
    for (const guard of guards) this.check(guard.document.path, guard.document.page.revision, guard.document.version);
    if (options.version !== undefined) this.checkTree(options.version);
    this.files.commit(writes, caseOnly ? [] : [...folders.map(old => ({ path: mapping.get(old) ?? '', old: false, next: true })), ...folders.map(path => ({ path, old: true, next: false }))], caseOnly ? { from, to: path } : undefined);
    this.reconcile(false);
    this.changedPages = [...this.pages].filter(([id, item]) => previous.get(id) !== item.document.version).map(([id, item]) => ({ id, revision: item.document.page.revision }));
    return { ...(folder ? {} : { document: this.document(path) }), moved: [...mapping].map(([from, to]) => ({ from, to })), updatedPaths, treeVersion: this.treeVersion() };
  }
  deleteFolder(path: string, version: string, recursive = false): VaultSnapshot {
    this.checkTree(version); validateVaultPath(path); const scan = this.files.list();
    if (!scan.folders.includes(path)) throw new NotFoundError('Папка не найдена');
    const files = scan.files.filter(file => file.startsWith(path + '/')); const folders = scan.folders.filter(dir => dir === path || dir.startsWith(path + '/'));
    if (scan.problems.some(problem => problem.path.startsWith(path + '/'))) throw new InvalidRequestError('Небезопасное дерево');
    if (!recursive && (files.length || folders.length > 1)) throw new AppError('conflict', 'Папка не пуста', 409, { currentRevision: 0, reason: 'destination_exists', paths: [path] });
    const trash = '.livenote/trash/' + randomUUID() + '/';
    const writes = files.flatMap(file => { const source = this.files.readBytes(file).bytes; return [{ path: trash + file, expected: null, source }, { path: file, expected: source, source: null }]; });
    this.checkTree(version);
    this.publish(writes, [], [...folders.map(path => ({ path: trash + path, old: false, next: true })), ...folders.map(path => ({ path, old: true, next: false }))]);
    return this.snapshot();
  }
  search(q = '', tag?: string): VaultSearchHit[] {
    if (q.length > 500) throw new InvalidRequestError('Поиск ограничен 500 символами');
    this.reconcile(); const tokens = folded(q.trim()).split(/\s+/).filter(Boolean); const hits: VaultSearchHit[] = [];
    for (const { document: d } of this.pages.values()) {
      if (!d.path.endsWith('.md') || (tag !== undefined && !d.tags.includes(tag))) continue;
      const prose = markdownProse(d.source).replace(/\s+/g, ' '); const haystack = folded([d.page.title, ...d.aliases, d.path, prose].join('\n'));
      if (tokens.every(token => haystack.includes(token))) hits.push({ pageId: d.path, title: d.page.title, path: d.path, tags: d.tags, excerpt: prose.slice(0, 240) });
    }
    return hits.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 100);
  }
  setRenderConfirmation(id: string, blockId: string, revision: number, ok: boolean, error: string | null): void { this.renders.set(id + '\0' + revision + '\0' + blockId, { revision, ok, error }); }
  private receiptPath(key: string): string { return `.livenote/requests/${sha256(key)}.json`; }
  replay<T>(key: string, input: unknown): T | undefined {
    const source = this.files.optional(this.receiptPath(key)); if (source === null) return undefined;
    const receipt = JSON.parse(source) as { created: number; signature: string; response: T };
    if (Date.now() - receipt.created > 86_400_000) return undefined;
    if (receipt.signature !== sha256(JSON.stringify(input))) throw new IdempotencyKeyError('requestId уже использован с другими параметрами');
    return receipt.response;
  }
  atomic<T>(key: string, input: unknown, action: () => T): T { const replay = this.replay<T>(key, input); return replay === undefined ? this.transaction(action, { key, input }) : replay; }
  private transaction<T>(action: () => T, receipt?: { key: string; input: unknown }): T {
    if (this.deferred) return action(); this.deferred = [];
    try {
      const response = action(); const writes = this.deferred;
      if (receipt) writes.push({ path: this.receiptPath(receipt.key), expected: this.files.optional(this.receiptPath(receipt.key)), source: JSON.stringify({ created: Date.now(), signature: sha256(JSON.stringify(receipt.input)), response }) });
      this.deferred = null; this.files.commit(writes); this.reconcile(false); return response;
    } catch (error) { this.deferred = null; this.reconcile(false); throw error; }
  }
  getIdempotency(key: string): string | null {
    const source = this.files.optional(this.receiptPath(key)); if (source === null) return null;
    const receipt = JSON.parse(source) as { created: number; response: unknown }; return Date.now() - receipt.created < 86_400_000 ? JSON.stringify(receipt.response) : null;
  }
  saveIdempotency(key: string, responseJson: string): void {
    const path = this.receiptPath(key); this.files.commit([{ path, source: JSON.stringify({ created: Date.now(), signature: sha256('null'), response: JSON.parse(responseJson) }), expected: this.files.optional(path) }]);
  }
  cleanupIdempotency(maxAgeMs: number): void {
    const expired: FileWrite[] = [];
    for (const path of this.files.list('.livenote/requests', true).files.filter(path => path.endsWith('.json'))) {
      const source = this.files.read(path).source; const receipt = JSON.parse(source) as { created: number };
      if (Date.now() - receipt.created > maxAgeMs) expired.push({ path, source: null, expected: source });
    }
    if (expired.length) this.files.commit(expired);
  }
  close(): void { if (this.closed) return; this.closed = true; clearInterval(this.timer); clearTimeout(this.debounce); this.watcher?.close(); this.files.close(); }
}
