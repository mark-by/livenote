/**
 * Хранилище LiveNote на SQLite (better-sqlite3).
 * Пишет только процесс LiveNote — агенты и UI ходят через сервисы.
 * Все мутации страницы инкрементируют её revision и защищены expected_revision.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SHORT_ID_LENGTH } from '../shared/types.js';
import type { Block, BlockType, PageFull, PageSummary } from '../shared/types.js';
import { ConflictError, InvalidRequestError, NotFoundError } from './errors.js';

/** Данные блока так, как они лежат в БД. */
interface BlockRow {
  page_id: string;
  id: string;
  type: string;
  source: string;
  title: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  rendered_revision: number | null;
  render_ok: number | null;
  render_error: string | null;
}

interface PageRow {
  id: string;
  title: string;
  revision: number;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Новый блок для импорта страницы целиком. */
export interface NewBlock {
  id?: string;
  type: BlockType;
  source: string;
  /** Название диаграммы над схемой; для markdown не задаётся. */
  title?: string | null;
}

export class NoteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    // Ключи идемпотентности старше суток больше не нужны.
    this.cleanupIdempotency(24 * 60 * 60 * 1000);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.migrateBlocksTable();
    this.ensureTitleColumn();
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id, position)`);
  }

  /**
   * Таблица blocks: новые БД создаются без CHECK-ограничения на type
   * (тип валидируется в коде — добавление форматов не требует миграций).
   * Старые БД с CHECK (type IN ('markdown','mermaid')) пересоздаются копированием.
   */
  private migrateBlocksTable(): void {
    const existing = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blocks'`)
      .get() as { sql: string } | undefined;
    if (existing === undefined) {
      this.db.exec(`
        CREATE TABLE blocks (
          page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          type TEXT NOT NULL,
          source TEXT NOT NULL,
          position INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          rendered_revision INTEGER,
          render_ok INTEGER,
          render_error TEXT,
          PRIMARY KEY (page_id, id)
        )
      `);
      return;
    }
    if (!existing.sql.includes('CHECK')) {
      return;
    }
    const tx = this.db.transaction(() => {
      this.db.exec(`ALTER TABLE blocks RENAME TO blocks_legacy`);
      this.db.exec(`
        CREATE TABLE blocks (
          page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          type TEXT NOT NULL,
          source TEXT NOT NULL,
          position INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          rendered_revision INTEGER,
          render_ok INTEGER,
          render_error TEXT,
          PRIMARY KEY (page_id, id)
        )
      `);
      this.db.exec(`
        INSERT INTO blocks (page_id, id, type, source, position, created_at, updated_at, rendered_revision, render_ok, render_error)
        SELECT page_id, id, type, source, position, created_at, updated_at, rendered_revision, render_ok, render_error
        FROM blocks_legacy
      `);
      this.db.exec(`DROP TABLE blocks_legacy`);
    });
    tx();
  }

  /**
   * Колонка blocks.title — название диаграммы над схемой (вне SVG). Добавляется
   * простым ALTER для существующих БД: колонка необязательная (NULL — без названия).
   */
  private ensureTitleColumn(): void {
    const columns = this.db.prepare(`PRAGMA table_info(blocks)`).all() as { name: string }[];
    if (!columns.some((column) => column.name === 'title')) {
      this.db.exec(`ALTER TABLE blocks ADD COLUMN title TEXT`);
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  private shortId(): string {
    return randomUUID().replace(/-/g, '').slice(0, SHORT_ID_LENGTH);
  }

  // ---------------------------------------------------------------------------
  // Страницы
  // ---------------------------------------------------------------------------

  listPages(): PageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, revision, created_at, updated_at
         FROM pages WHERE deleted_at IS NULL
         ORDER BY position ASC, created_at ASC`
      )
      .all() as PageRow[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  /** Страница целиком; undefined — не найдена или в корзине. */
  getPage(pageId: string): PageFull | undefined {
    const page = this.db
      .prepare(
        `SELECT id, title, revision, created_at, updated_at
         FROM pages WHERE id = ? AND deleted_at IS NULL`
      )
      .get(pageId) as PageRow | undefined;
    if (!page) {
      return undefined;
    }
    const blocks = this.db
      .prepare(
        `SELECT * FROM blocks WHERE page_id = ? ORDER BY position ASC, created_at ASC`
      )
      .all(pageId) as BlockRow[];
    return {
      id: page.id,
      title: page.title,
      revision: page.revision,
      createdAt: page.created_at,
      updatedAt: page.updated_at,
      blocks: blocks.map((row) => this.rowToBlock(row))
    };
  }

  createPage(title: string): PageFull {
    const now = this.now();
    const id = randomUUID();
    const position = this.maxPagePosition() + 1;
    this.db
      .prepare(
        `INSERT INTO pages (id, title, revision, position, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)`
      )
      .run(id, title, position, now, now);
    return this.requirePage(id);
  }

  /** Импорт страницы с готовым набором блоков (одна транзакция, revision = 1). */
  createPageWithBlocks(title: string, blocks: NewBlock[]): PageFull {
    const now = this.now();
    const id = randomUUID();
    const position = this.maxPagePosition() + 1;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO pages (id, title, revision, position, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)`
        )
        .run(id, title, position, now, now);
      const insert = this.db.prepare(
        `INSERT INTO blocks (page_id, id, type, source, title, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      blocks.forEach((block, index) => {
        insert.run(id, block.id ?? this.shortId(), block.type, block.source, block.title ?? null, index, now, now);
      });
    });
    tx();
    return this.requirePage(id);
  }

  /** Перенос в корзину: содержимое остаётся в БД. */
  softDeletePage(pageId: string, expectedRevision: number): void {
    const tx = this.db.transaction(() => {
      const page = this.lockPage(pageId);
      this.checkRevision(page, expectedRevision);
      this.db
        .prepare(`UPDATE pages SET deleted_at = ?, updated_at = ? WHERE id = ?`)
        .run(this.now(), this.now(), pageId);
    });
    tx();
  }

  /** Переименование, порядок блоков, удаление выбранных блоков — за одну ревизию. */
  updatePage(
    pageId: string,
    patch: { title?: string; blockOrder?: string[]; deleteBlockIds?: string[] },
    expectedRevision: number
  ): PageFull {
    const tx = this.db.transaction(() => {
      const page = this.lockPage(pageId);
      this.checkRevision(page, expectedRevision);
      const now = this.now();

      if (patch.deleteBlockIds && patch.deleteBlockIds.length > 0) {
        const del = this.db.prepare(`DELETE FROM blocks WHERE page_id = ? AND id = ?`);
        for (const blockId of patch.deleteBlockIds) {
          const info = del.run(pageId, blockId);
          if (info.changes === 0) {
            throw new NotFoundError(
              `Блок "${blockId}" не найден на странице "${pageId}"`,
              { pageId, blockId }
            );
          }
        }
      }

      if (patch.title !== undefined) {
        this.db
          .prepare(`UPDATE pages SET title = ?, updated_at = ? WHERE id = ?`)
          .run(patch.title, now, pageId);
      }

      if (patch.blockOrder) {
        const remaining = this.db
          .prepare(`SELECT id FROM blocks WHERE page_id = ?`)
          .all(pageId) as { id: string }[];
        const existing = new Set(remaining.map((row) => row.id));
        const ordered = new Set(patch.blockOrder);
        if (
          existing.size !== patch.blockOrder.length ||
          [...existing].some((blockId) => !ordered.has(blockId))
        ) {
          throw new InvalidRequestError(
            'blockOrder должен содержать ровно все оставшиеся блоки страницы, без повторов',
            { existing: [...existing], provided: patch.blockOrder }
          );
        }
        const update = this.db.prepare(
          `UPDATE blocks SET position = ? WHERE page_id = ? AND id = ?`
        );
        patch.blockOrder.forEach((blockId, index) => {
          update.run(index, pageId, blockId);
        });
      }

      this.db
        .prepare(`UPDATE pages SET revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(now, pageId);
    });
    tx();
    return this.requirePage(pageId);
  }

  // ---------------------------------------------------------------------------
  // Блоки
  // ---------------------------------------------------------------------------

  /**
   * Создать блок или полностью заменить существующий (upsert по паре page_id + block id).
   * Новый блок добавляется в конец страницы. Тип блока тоже заменяется.
   * Ревизия страницы инкрементируется только при фактическом изменении содержимого.
   */
  upsertBlock(
    pageId: string,
    blockId: string,
    type: BlockType,
    source: string,
    expectedRevision: number,
    title?: string | null
  ): { page: PageFull; created: boolean } {
    if (type !== 'markdown' && type !== 'mermaid' && type !== 'bpmn' && type !== 'drawio') {
      throw new InvalidRequestError(`Неизвестный тип блока "${type}"`);
    }
    let created = false;
    const tx = this.db.transaction(() => {
      const page = this.lockPage(pageId);
      this.checkRevision(page, expectedRevision);
      const now = this.now();
      const existing = this.db
        .prepare(`SELECT id, title FROM blocks WHERE page_id = ? AND id = ?`)
        .get(pageId, blockId) as { id: string; title: string | null } | undefined;
      // title undefined — «не менять» (сохраняется прежнее название), иначе записываем как есть.
      const nextTitle = title === undefined ? (existing?.title ?? null) : title;

      if (existing) {
        this.db
          .prepare(
            `UPDATE blocks
             SET type = ?, source = ?, title = ?, updated_at = ?,
                 rendered_revision = NULL, render_ok = NULL, render_error = NULL
             WHERE page_id = ? AND id = ?`
          )
          .run(type, source, nextTitle, now, pageId, blockId);
      } else {
        created = true;
        const maxPos = this.maxBlockPosition(pageId);
        this.db
          .prepare(
            `INSERT INTO blocks (page_id, id, type, source, title, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(pageId, blockId, type, source, nextTitle, maxPos + 1, now, now);
      }

      this.db
        .prepare(`UPDATE pages SET revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(now, pageId);
    });
    tx();
    return { page: this.requirePage(pageId), created };
  }

  deleteBlock(pageId: string, blockId: string, expectedRevision: number): PageFull {
    const tx = this.db.transaction(() => {
      const page = this.lockPage(pageId);
      this.checkRevision(page, expectedRevision);
      const info = this.db
        .prepare(`DELETE FROM blocks WHERE page_id = ? AND id = ?`)
        .run(pageId, blockId);
      if (info.changes === 0) {
        throw new NotFoundError(
          `Блок "${blockId}" не найден на странице "${pageId}"`,
          { pageId, blockId }
        );
      }
      this.db
        .prepare(`UPDATE pages SET revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(this.now(), pageId);
    });
    tx();
    return this.requirePage(pageId);
  }

  /**
   * Подтверждение фактического отображения блока в UI.
   * Сознательно НЕ меняет revision страницы: это не изменение содержимого.
   */
  setRenderConfirmation(
    pageId: string,
    blockId: string,
    revision: number,
    ok: boolean,
    error: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE blocks
         SET rendered_revision = ?, render_ok = ?, render_error = ?
         WHERE page_id = ? AND id = ?`
      )
      .run(revision, ok ? 1 : 0, error, pageId, blockId);
  }

  // ---------------------------------------------------------------------------
  // Идемпотентность (request_id)
  // ---------------------------------------------------------------------------

  /** Сохранённый JSON-результат по request_id, либо null. */
  getIdempotency(key: string): string | null {
    const row = this.db
      .prepare(`SELECT response FROM idempotency WHERE key = ?`)
      .get(key) as { response: string } | undefined;
    return row?.response ?? null;
  }

  /** Сохраняет результат; ключ, сохранённый параллельно, не перезаписывает. */
  saveIdempotency(key: string, responseJson: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO idempotency (key, response, created_at) VALUES (?, ?, ?)`)
      .run(key, responseJson, this.now());
  }

  cleanupIdempotency(maxAgeMs: number): void {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    this.db.prepare(`DELETE FROM idempotency WHERE created_at < ?`).run(cutoff);
  }

  // ---------------------------------------------------------------------------
  // Внутреннее
  // ---------------------------------------------------------------------------

  private rowToBlock(row: BlockRow): Block {
    const type: BlockType =
      row.type === 'mermaid' || row.type === 'bpmn' || row.type === 'drawio' ? row.type : 'markdown';
    return {
      id: row.id,
      pageId: row.page_id,
      type,
      source: row.source,
      title: row.title,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      renderedRevision: row.rendered_revision,
      renderOk: row.render_ok === null ? null : row.render_ok === 1,
      renderError: row.render_error
    };
  }

  private maxPagePosition(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(position), -1) AS max_pos FROM pages`)
      .get() as { max_pos: number };
    return row.max_pos;
  }

  private maxBlockPosition(pageId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(position), -1) AS max_pos FROM blocks WHERE page_id = ?`)
      .get(pageId) as { max_pos: number };
    return row.max_pos;
  }

  /** Загружает страницу внутри транзакции; бросает NotFound для отсутствующих/удалённых. */
  private lockPage(pageId: string): PageRow {
    const page = this.db
      .prepare(`SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL`)
      .get(pageId) as PageRow | undefined;
    if (!page) {
      throw new NotFoundError(`Страница "${pageId}" не найдена`, { pageId });
    }
    return page;
  }

  private checkRevision(page: PageRow, expectedRevision: number): void {
    if (page.revision !== expectedRevision) {
      throw new ConflictError(
        `Конфликт ревизии страницы "${page.id}": ожидалась ${expectedRevision}, текущая ${page.revision}. Перечитайте страницу.`,
        page.revision
      );
    }
  }

  private requirePage(pageId: string): PageFull {
    const page = this.getPage(pageId);
    if (!page) {
      throw new NotFoundError(`Страница "${pageId}" не найдена`, { pageId });
    }
    return page;
  }
}
