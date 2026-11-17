// allow: SIZE_OK — общий NoteService сохраняет порядок validation, commit, events и idempotency для REST/MCP.
/**
 * Ядро LiveNote: операции над страницами и блоками.
 * REST и MCP-слои — тонкие обёртки над этим классом, чтобы поведение совпадало:
 * одинаковые проверки ревизий, одинаковые события SSE, одинаковая идемпотентность.
 */
import { ID_PATTERN } from '../shared/types.js';
import type {
  BlockType,
  Broadcaster,
  CheckDiagramResult,
  DiagramFormat,
  DiagramValidation,
  DiagramValidator,
  LiveEvent,
  LiveEventName,
  PageFull,
  PageSummary,
  WriteBlockResult,
  WriteLayout
} from '../shared/types.js';
import type { CreatePageBody, MoveVaultPageBody, PatchVaultMetadataBody, VaultDocument, WriteVaultDocumentBody } from '../shared/types.js';
import type { PageStore } from './store.js';
import { VaultStore } from './vault.js';
import type { NewBlock } from './db.js';
import { AppError, InvalidRequestError, NotFoundError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type { BpmnValidator } from './validator/bpmn.js';
import { diagramFormat } from './vaultDocument.js';

/** Патч для update_page: что поменять на странице. */
export interface UpdatePageInput {
  title?: string;
  blockOrder?: string[];
  deleteBlockIds?: string[];
}

export class NoteService {
  private pendingEvents: LiveEvent[] | null = null;
  constructor(
    private readonly store: PageStore,
    private readonly broadcaster: Broadcaster,
    private readonly validator: DiagramValidator,
    private readonly bpmnValidator: BpmnValidator,
    private readonly drawioValidator: DiagramValidator
  ) {}

  // ---------------------------------------------------------------------------
  // Чтение
  // ---------------------------------------------------------------------------

  listPages(): PageSummary[] {
    return this.store.listPages();
  }

  getPage(pageId: string): PageFull {
    const page = this.store.getPage(pageId);
    if (!page) {
      throw new NotFoundError(`Страница "${pageId}" не найдена`, { pageId });
    }
    return page;
  }

  // ---------------------------------------------------------------------------
  // Страницы
  // ---------------------------------------------------------------------------

  addPage(title: string, requestId?: string, options: Partial<CreatePageBody> = {}): PageFull {
    const cleanTitle = normalizeTitle(title);
    if (!(this.store instanceof VaultStore) && (options.path !== undefined || options.aliases !== undefined || options.tags !== undefined || options.source !== undefined || options.format !== undefined)) {
      throw new InvalidRequestError('Пути, aliases и tags доступны только в vault');
    }
    const create = (): PageFull => {
      const page = this.store instanceof VaultStore ? this.store.createPage(cleanTitle, options) : this.store.createPage(cleanTitle);
      this.publish('page.created', page.id, page.revision);
      return page;
    };
    if (requestId !== undefined) {
      return this.withIdempotency(requestId, create, { operation: 'add_page', title: cleanTitle, ...options });
    }
    return create();
  }

  async createDocument(body: CreatePageBody): Promise<PageFull> {
    if ((body.format || (body.path && diagramFormat(body.path))) && body.source === undefined) throw new InvalidRequestError('Для диаграммы требуется source');
    if (this.store instanceof VaultStore) {
      if (body.requestId !== undefined) {
        const replay = this.store.replay<PageFull>(body.requestId, { operation: 'add_page', ...body });
        if (replay !== undefined) return replay;
      }
      const preview = this.store.inspectCreation(body);
      for (const block of preview.document.page.blocks) {
        if (block.type === 'markdown') continue;
        if (preview.document.assets.some(asset => asset.source === null)) throw new AppError('diagram_invalid', 'Файл диаграммы отсутствует', 422);
        const validation = await (block.type === 'bpmn' ? this.bpmnValidator : block.type === 'drawio' ? this.drawioValidator : this.validator).parse(block.source);
        if (validation.syntax === 'error' || (block.type === 'bpmn' && validation.hasDiagram !== true)) throw new AppError('diagram_invalid', 'Ошибка диаграммы', 422, { validation });
      }
      if (this.store.inspectCreation(body).document.version !== preview.document.version) throw new AppError('conflict', 'Диаграммы изменились во время проверки', 409, { currentRevision: 0, reason: 'stale' });
    }
    return this.addPage(body.title, body.requestId, body);
  }

  /** Импорт Markdown-контента в новую страницу (используется REST-импортом). */
  async importPage(title: string | undefined, blocks: NewBlock[]): Promise<PageFull> {
    if (blocks.length === 0) {
      throw new InvalidRequestError('Импортируемый документ не содержит блоков');
    }
    if (this.store instanceof VaultStore) {
      for (const [index, block] of blocks.entries()) {
        if (block.type === 'markdown') continue;
        const validator = block.type === 'bpmn' ? this.bpmnValidator : block.type === 'drawio' ? this.drawioValidator : this.validator;
        const validation = await validator.parse(block.source);
        if (validation.syntax === 'error') throw new AppError('diagram_invalid', 'Ошибка импортируемой диаграммы', 422, { blockId: block.id ?? `import-${index}`, validation });
      }
    }
    const page = this.store.createPageWithBlocks(
      normalizeTitle(title ?? 'Импортированная страница'),
      blocks
    );
    this.publish('page.created', page.id, page.revision);
    return page;
  }

  updatePage(pageId: string, patch: UpdatePageInput, expectedRevision: number): PageFull {
    const cleanTitle = patch.title !== undefined ? normalizeTitle(patch.title) : undefined;
    const page = this.store.updatePage(
      pageId,
      { ...patch, title: cleanTitle },
      expectedRevision
    );
    if (page.id !== pageId) {
      this.broadcaster.publish({ event: 'page.moved', pageId: page.id, previousPath: pageId, revision: page.revision, origin: 'api', ts: Date.now() });
      this.publish('vault.updated', '', 0);
    }
    if (page.revision !== expectedRevision) this.publish('page.updated', page.id, page.revision);
    this.publishRelated(page.id);
    return page;
  }

  deletePage(pageId: string, expectedRevision: number, expectedVersion?: string): void {
    if (this.store instanceof VaultStore) this.store.check(pageId, expectedRevision, expectedVersion);
    this.store.softDeletePage(pageId, expectedRevision);
    // Ревизию для события берём прежнюю: страница исчезла из активного набора.
    this.publish('page.deleted', pageId, expectedRevision);
  }

  // ---------------------------------------------------------------------------
  // Блоки
  // ---------------------------------------------------------------------------

  /**
   * Создать/заменить markdown- или диаграммный блок.
   * Mermaid и draw.io: синтаксис проверяется до записи, ошибка не публикуется.
   * BPMN: XML разбирается (bpmn-moddle), lint-замечания не блокируют; раскладка
   * зависит от режима layout — preserve требует BPMNDI, auto пересчитывает её.
   */
  async writeBlock(
    pageId: string,
    blockId: string | undefined,
    type: BlockType,
    source: string,
    expectedRevision: number,
    requestId?: string,
    options: { layout?: WriteLayout; title?: string | null; at?: number; expectedVersion?: string } = {}
  ): Promise<WriteBlockResult> {
    if (typeof source !== 'string' || (source.trim().length === 0 && !(this.store instanceof VaultStore && type === 'markdown'))) {
      throw new InvalidRequestError('source не может быть пустым');
    }
    const id = this.store instanceof VaultStore ? blockId ?? '' : normalizeBlockId(blockId);
    // Название диаграммы над схемой: undefined — не менять, пустая строка — убрать.
    const title =
      options.title === undefined
        ? undefined
        : options.title === null || options.title.trim() === ''
          ? null
          : options.title.trim().slice(0, 200);
    const receiptInput = { operation: 'write_block', pageId, blockId, type, source, expectedRevision, options: { ...options, title } };
    if (requestId !== undefined && this.store instanceof VaultStore) {
      const replay = this.store.replay<WriteBlockResult>(requestId, receiptInput);
      if (replay !== undefined) return replay;
    }
    if (this.store instanceof VaultStore) {
      const current = this.store.check(pageId, expectedRevision, options.expectedVersion);
      if (blockId !== undefined && !current.spans.some(span => span.id === blockId)) throw new NotFoundError('Блок не найден в текущей ревизии', { blockId });
    }

    // Проверки диаграмм выполняются до записи: при ошибке новая версия не публикуется.
    let validation: DiagramValidation | undefined;
    if (type === 'mermaid') {
      validation = await this.validator.parse(source);
      if (validation.syntax === 'error') {
        const page = this.getPage(pageId);
        return { pageId, blockId: id, revision: page.revision, validation };
      }
    } else if (type === 'drawio') {
      validation = await this.drawioValidator.parse(source);
      if (validation.syntax === 'error') {
        const page = this.getPage(pageId);
        return { pageId, blockId: id, revision: page.revision, validation };
      }
    } else if (type === 'bpmn') {
      const write = await this.writeBpmn(pageId, id, source, options.layout ?? 'preserve');
      if ('validation' in write && write.validation.syntax === 'error') {
        return { pageId, blockId: id, revision: this.getPage(pageId).revision, validation: write.validation };
      }
      validation = write.validation;
      source = write.source;
    }

    const write = (): WriteBlockResult => {
      if (this.store instanceof VaultStore) this.store.check(pageId, expectedRevision, options.expectedVersion);
      const result = this.store instanceof VaultStore
        ? this.store.upsertBlock(pageId, blockId, type, source, expectedRevision, title, options.at)
        : this.store.upsertBlock(pageId, id, type, source, expectedRevision, title);
      const actualId = 'blockId' in result && typeof result.blockId === 'string' ? result.blockId : id;
      if (result.page.revision !== expectedRevision) this.publish(result.created ? 'block.created' : 'block.updated', pageId, result.page.revision, actualId);
      this.publishRelated(pageId);
      return { pageId, blockId: actualId, revision: result.page.revision, validation };
    };

    if (requestId !== undefined) {
      return this.withIdempotency(requestId, write, receiptInput);
    }
    return write();
  }

  /**
   * Подготовка BPMN-источника к записи: проверка XML, раскладка, lint.
   * Возвращает финальный source и валидацию; при ошибке — validation.syntax = 'error'.
   */
  private async writeBpmn(
    pageId: string,
    blockId: string,
    source: string,
    layout: WriteLayout
  ): Promise<{ source: string; validation: DiagramValidation }> {
    let validation = await this.bpmnValidator.parse(source);

    if (validation.syntax === 'error') {
      return { source, validation };
    }

    const hasDiagram = validation.hasDiagram === true;
    if (!hasDiagram && layout === 'preserve') {
      return {
        source,
        validation: {
          ...validation,
          syntax: 'error',
          error: {
            message:
              'XML без геометрии BPMNDI: передайте layout: "auto" для автораскладки или добавьте секцию bpmndi:BPMNDiagram'
          }
        }
      };
    }

    if (layout === 'auto') {
      const laid = await this.bpmnValidator.layout(source);
      if (!laid.ok || laid.xml === undefined) {
        return {
          source,
          validation: {
            ...validation,
            syntax: 'error',
            error: { message: `Автораскладка не удалась: ${laid.error ?? 'неизвестная ошибка'}` }
          }
        };
      }
      source = laid.xml;
      validation = {
        ...validation,
        hasDiagram: true,
        warning: hasDiagram
          ? 'Раскладка пересчитана: ручное расположение элементов могло измениться'
          : 'Добавлена автораскладка (XML не содержал BPMNDI)'
      };
    }

    return { source, validation };
  }

  /**
   * Явный пересчёт раскладки существующего BPMN-блока.
   * Публикует новую ревизию страницы — как обычное изменение содержимого.
   */
  async layoutDiagram(
    pageId: string,
    blockId: string,
    expectedRevision: number
  ): Promise<WriteBlockResult> {
    const page = this.getPage(pageId);
    const block = page.blocks.find((candidate) => candidate.id === blockId);
    if (!block) {
      throw new NotFoundError(`Блок "${blockId}" не найден на странице "${pageId}"`, { pageId, blockId });
    }
    if (block.type !== 'bpmn') {
      throw new InvalidRequestError(
        `layout_diagram применим только к bpmn-блокам (блок "${blockId}" — ${block.type})`,
        { pageId, blockId, blockType: block.type }
      );
    }
    const laid = await this.bpmnValidator.layout(block.source);
    if (!laid.ok || laid.xml === undefined) {
      throw new InvalidRequestError(`Автораскладка не удалась: ${laid.error ?? 'неизвестная ошибка'}`);
    }
    const { page: updated } = this.store.upsertBlock(pageId, blockId, 'bpmn', laid.xml, expectedRevision);
    this.publish('block.updated', pageId, updated.revision, blockId);
    return {
      pageId,
      blockId,
      revision: updated.revision,
      validation: {
        syntax: 'ok',
        renderer: this.bpmnValidator.kind,
        hasDiagram: true,
        warning: 'Раскладка пересчитана: ручное расположение элементов могло измениться'
      }
    };
  }

  deleteBlock(pageId: string, blockId: string, expectedRevision: number): PageFull {
    const page = this.store.deleteBlock(pageId, blockId, expectedRevision);
    this.publish('block.deleted', pageId, page.revision, blockId);
    return page;
  }

  private vault(): VaultStore {
    if (!(this.store instanceof VaultStore)) throw new AppError('vault_required', 'Операция доступна только в vault', 409);
    return this.store;
  }

  vaultSnapshot() { return this.vault().snapshot(); }
  exportVault(): Buffer { return this.vault().exportArchive(); }
  getDocument(pageId: string): VaultDocument { return this.vault().document(pageId); }
  search(q = '', tag?: string) { return this.vault().search(q, tag); }

  async writeDocument(pageId: string, body: WriteVaultDocumentBody): Promise<VaultDocument> {
    const store = this.vault();
    const input = { operation: 'write_document', pageId, ...body, requestId: undefined };
    if (body.requestId !== undefined) {
      const replay = store.replay<VaultDocument>(body.requestId, input);
      if (replay !== undefined) return replay;
    }
    let candidate = body;
    let prepared = store.prepare(pageId, candidate);
    for (const block of prepared.next.document.page.blocks) {
      if (block.type === 'markdown') continue;
      const span = prepared.next.document.spans.find(span => span.blockId === block.id);
      const previousAsset = span?.assetPath ? prepared.previous.document.assets.find(asset => asset.path === span.assetPath) : undefined;
      if (span?.assetPath && !previousAsset && prepared.next.document.assets.some(asset => asset.path === span.assetPath && asset.source === null)) throw new AppError('diagram_invalid', 'Файл диаграммы отсутствует', 422, { blockId: block.id });
      if (span?.assetPath && previousAsset?.source === (prepared.next.document.assets.find(asset => asset.path === span.assetPath)?.source) && !prepared.assets.has(span.assetPath)) continue;
      if (!span?.assetPath && prepared.previous.document.page.blocks.some(old => old.type === block.type && old.source === block.source)) continue;
      const assetBody = body.assets?.find(asset => asset.path === span?.assetPath);
      const checked = block.type === 'bpmn' ? await this.writeBpmn(pageId, block.id, block.source, assetBody?.layout ?? 'preserve') : { source: block.source, validation: await (block.type === 'drawio' ? this.drawioValidator : this.validator).parse(block.source) };
      const { validation } = checked;
      if (validation.syntax === 'error') throw new AppError('diagram_invalid', 'Ошибка синтаксиса диаграммы', 422, { blockId: block.id, validation });
      if (checked.source !== block.source) {
        if (span?.assetPath) {
          const assets = candidate.assets?.map(asset => asset.path === span.assetPath ? { ...asset, source: checked.source } : asset);
          candidate = { ...candidate, assets };
        } else candidate = { ...candidate, source: checked.source };
        prepared = store.prepare(pageId, candidate);
      }
    }
    const action = (): VaultDocument => {
      const result = store.finish(pageId, prepared);
      if (result.version !== prepared.previous.document.version) this.publish('page.updated', pageId, result.page.revision);
      this.publishRelated(pageId);
      return result;
    };
    return body.requestId === undefined ? action() : this.withIdempotency(body.requestId, action, input);
  }

  patchMetadata(pageId: string, body: PatchVaultMetadataBody): VaultDocument {
    const result = this.vault().metadata(pageId, body);
    if (result.path !== pageId) {
      this.broadcaster.publish({ event: 'page.moved', pageId: result.path, previousPath: pageId, revision: result.page.revision, origin: 'api', ts: Date.now() });
      this.publish('vault.updated', '', 0);
    }
    if (result.page.revision !== body.expectedRevision) this.publish('page.updated', result.path, result.page.revision);
    this.publishRelated(result.path);
    return result;
  }

  movePage(pageId: string, body: MoveVaultPageBody) {
    const result = this.vault().move(pageId, body);
    if (result.moved.length) {
      this.broadcaster.publish({ event: 'page.moved', pageId: body.path, previousPath: pageId, revision: result.document?.page.revision ?? 0, origin: 'api', ts: Date.now() });
      this.publish('vault.updated', '', 0);
      for (const path of result.updatedPaths) if (path !== body.path) this.publish('page.updated', path, this.getPage(path).revision);
    }
    return result;
  }
  createFolder(path: string, version: string) { const snapshot = this.vault().createFolder(path, version); this.publish('vault.updated', '', 0); return snapshot; }
  moveFolder(from: string, path: string, version: string) {
    const result = this.vault().moveFolder(from, path, version); this.publish('vault.updated', '', 0);
    this.publishRelated('');
    return result;
  }
  deleteFolder(path: string, version: string, recursive?: boolean) {
    const store = this.vault(); const deleted = store.snapshot().files.filter(file => file.path.startsWith(path + '/'));
    const snapshot = store.deleteFolder(path, version, recursive); this.publish('vault.updated', '', 0);
    for (const file of deleted) this.publish('page.deleted', file.path, file.revision);
    this.publishRelated(''); return snapshot;
  }

  /** Подтверждение из UI: какая ревизия блока фактически отображается. Ревизию не меняет. */
  setRendered(pageId: string, blockId: string, confirmation: { revision: number; ok: boolean; error?: string }): void {
    this.store.setRenderConfirmation(
      pageId,
      blockId,
      confirmation.revision,
      confirmation.ok,
      confirmation.error ?? null
    );
  }

  // ---------------------------------------------------------------------------
  // Проверка диаграмм
  // ---------------------------------------------------------------------------

  /**
   * check_diagram: syntax — mermaid.parse без рендера; render — полная отрисовка
   * (и PNG при includeImage). Если передан revision и он устарел — перечитайте страницу.
   */
  async checkDiagram(
    pageId: string,
    blockId: string,
    options: { revision?: number; mode?: 'syntax' | 'render'; includeImage?: boolean } = {}
  ): Promise<CheckDiagramResult> {
    const page = this.getPage(pageId);
    const block = page.blocks.find((candidate) => candidate.id === blockId);
    if (!block) {
      throw new NotFoundError(
        `Блок "${blockId}" не найден на странице "${pageId}"`,
        { pageId, blockId }
      );
    }
    if (options.revision !== undefined && options.revision !== page.revision) {
      return {
        pageId,
        blockId,
        revision: page.revision,
        stale: true,
        validation: { syntax: 'not_checked', renderer: 'unavailable' }
      };
    }

    const mode = options.mode ?? 'syntax';

    if (mode === 'syntax') {
      let validation: DiagramValidation;
      if (block.type === 'bpmn') {
        validation = await this.bpmnValidator.parse(block.source);
      } else if (block.type === 'drawio') {
        validation = await this.drawioValidator.parse(block.source);
      } else {
        validation = await this.validator.parse(block.source);
      }
      return { pageId, blockId, revision: page.revision, stale: false, validation };
    }

    if (block.type === 'markdown') {
      throw new InvalidRequestError(
        `Блок "${blockId}" — markdown, проверка диаграммы неприменима`,
        { pageId, blockId, blockType: block.type }
      );
    }

    const renderOptions = { includeImage: options.includeImage };
    let result: { validation: DiagramValidation; render?: import('../shared/types.js').DiagramRenderResult };
    if (block.type === 'bpmn') {
      result = await this.bpmnValidator.render(block.source, renderOptions);
    } else if (block.type === 'drawio') {
      result = await this.drawioValidator.render(block.source, renderOptions);
    } else {
      result = await this.validator.render(block.source, renderOptions);
    }
    const { validation, render } = result;
    return {
      pageId,
      blockId,
      revision: page.revision,
      stale: false,
      validation,
      ...(render ? { render } : {})
    };
  }

  // ---------------------------------------------------------------------------
  // Вспомогательное
  // ---------------------------------------------------------------------------

  private publish(event: LiveEventName, pageId: string, revision: number, blockId?: string): void {
    const message: LiveEvent = { event, pageId, revision, ...(blockId ? { blockId } : {}), origin: 'api', ts: Date.now() };
    if (this.pendingEvents) this.pendingEvents.push(message);
    else this.broadcaster.publish(message);
  }

  private publishRelated(pageId: string): void {
    if (this.store instanceof VaultStore) {
      for (const changed of this.store.changedPages) {
        if (changed.id !== pageId) this.publish('page.updated', changed.id, changed.revision);
      }
    }
  }

  /**
   * Повтор вызова с тем же request_id возвращает сохранённый результат,
   * а не создаёт дубликат. Смена тела при том же ключе — ошибка.
   */
  private withIdempotency<T>(requestId: string, action: () => T, input?: unknown): T {
    if (this.store instanceof VaultStore) {
      this.pendingEvents = [];
      try {
        const result = this.store.atomic(requestId, input, action);
        const events = this.pendingEvents;
        this.pendingEvents = null;
        for (const event of events) this.broadcaster.publish(event);
        return result;
      } catch (error) { this.pendingEvents = null; throw error; }
    }
    const stored = this.store.getIdempotency(requestId);
    if (stored !== null) {
      return JSON.parse(stored) as T;
    }
    const result = action();
    this.store.saveIdempotency(requestId, JSON.stringify(result));
    return result;
  }
}

/** Название страницы: непустое, обрезанное. */
function normalizeTitle(title: string): string {
  const clean = (title ?? '').trim();
  if (clean.length === 0) {
    return 'Без названия';
  }
  return clean.slice(0, 200);
}

/** ID блока: либо валидный от автора, либо автогенерированный. */
function normalizeBlockId(blockId: string | undefined): string {
  if (blockId === undefined || blockId.trim() === '') {
    return 'block-' + randomUUID().replace(/-/g, '').slice(0, 8);
  }
  const clean = blockId.trim();
  if (!ID_PATTERN.test(clean)) {
    throw new InvalidRequestError(
      `Недопустимый block_id "${blockId}": разрешены латиница, цифры, "-", "_", до 64 символов`,
      { blockId }
    );
  }
  return clean;
}
