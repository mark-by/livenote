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
import { NoteStore } from './db.js';
import type { NewBlock } from './db.js';
import { InvalidRequestError, NotFoundError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type { BpmnValidator } from './validator/bpmn.js';

/** Патч для update_page: что поменять на странице. */
export interface UpdatePageInput {
  title?: string;
  blockOrder?: string[];
  deleteBlockIds?: string[];
}

export class NoteService {
  constructor(
    private readonly store: NoteStore,
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

  addPage(title: string, requestId?: string): PageFull {
    const cleanTitle = normalizeTitle(title);
    const create = (): PageFull => {
      const page = this.store.createPage(cleanTitle);
      this.publish('page.created', page.id, page.revision);
      return page;
    };
    if (requestId !== undefined) {
      return this.withIdempotency(requestId, create);
    }
    return create();
  }

  /** Импорт Markdown-контента в новую страницу (используется REST-импортом). */
  importPage(title: string | undefined, blocks: NewBlock[]): PageFull {
    if (blocks.length === 0) {
      throw new InvalidRequestError('Импортируемый документ не содержит блоков');
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
    this.publish('page.updated', pageId, page.revision);
    return page;
  }

  deletePage(pageId: string, expectedRevision: number): void {
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
    options: { layout?: WriteLayout; title?: string | null } = {}
  ): Promise<WriteBlockResult> {
    if (typeof source !== 'string' || source.trim().length === 0) {
      throw new InvalidRequestError('source не может быть пустым');
    }
    const id = normalizeBlockId(blockId);
    // Название диаграммы над схемой: undefined — не менять, пустая строка — убрать.
    const title =
      options.title === undefined
        ? undefined
        : options.title === null || options.title.trim() === ''
          ? null
          : options.title.trim().slice(0, 200);

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
      const { page, created } = this.store.upsertBlock(pageId, id, type, source, expectedRevision, title);
      this.publish(created ? 'block.created' : 'block.updated', pageId, page.revision, id);
      return { pageId, blockId: id, revision: page.revision, validation };
    };

    if (requestId !== undefined) {
      return this.withIdempotency(requestId, write);
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
    this.broadcaster.publish({ event, pageId, revision, ...(blockId ? { blockId } : {}), ts: Date.now() });
  }

  /**
   * Повтор вызова с тем же request_id возвращает сохранённый результат,
   * а не создаёт дубликат. Смена тела при том же ключе — ошибка.
   */
  private withIdempotency<T>(requestId: string, action: () => T): T {
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
