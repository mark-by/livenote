import type { BlockType, PageFull, PageSummary, UpdatePagePatch } from '../shared/types.js';
import type { NewBlock } from './db.js';

/** Минимальный общий контракт существующих блочных операций. */
export interface PageStore {
  close(): void;
  listPages(): PageSummary[];
  getPage(pageId: string): PageFull | undefined;
  createPage(title: string): PageFull;
  createPageWithBlocks(title: string, blocks: NewBlock[]): PageFull;
  deletePage(pageId: string, expectedRevision: number): void;
  updatePage(pageId: string, patch: UpdatePagePatch, expectedRevision: number): PageFull;
  upsertBlock(pageId: string, blockId: string, type: BlockType, source: string, expectedRevision: number, title?: string | null): { page: PageFull; created: boolean };
  deleteBlock(pageId: string, blockId: string, expectedRevision: number): PageFull;
  setRenderConfirmation(pageId: string, blockId: string, revision: number, ok: boolean, error: string | null): void;
  getIdempotency(key: string): string | null;
  saveIdempotency(key: string, responseJson: string): void;
  cleanupIdempotency(maxAgeMs: number): void;
}
