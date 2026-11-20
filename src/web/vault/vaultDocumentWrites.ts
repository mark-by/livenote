import type { LiveEvent, VaultDocument, WriteVaultDocumentBody } from '../../shared/types';
import { putVaultDocument } from '../api';

export interface VaultDraft {
  readonly source: string;
  readonly baseRevision: number;
  readonly baseVersion: string;
  readonly epoch: number;
  readonly saving: boolean;
  readonly modalOpen: boolean;
  readonly externalChange: boolean;
  readonly conflict: string | null;
}

export interface DiagramWrite {
  readonly draftEpoch: number;
  readonly draftSource: string;
  readonly source: string;
  readonly assets?: WriteVaultDocumentBody['assets'];
  readonly references?: WriteVaultDocumentBody['references'];
}

export const TEXT_WRITE_CONFLICT =
  'Документ изменился вне этого редактора. Автосохранение остановлено; черновик и история редактирования сохранены.';

interface WriteState {
  readonly draft: () => VaultDraft | undefined;
  readonly patchDraft: (patch: Partial<VaultDraft>) => void;
  readonly publish: (document: VaultDocument) => void;
  readonly reload: () => void;
}

interface InFlightWrite {
  revision?: number;
  reload: boolean;
}

export class VaultDocumentWrites {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly inFlight = new Map<string, InFlightWrite>();
  private readonly unobservedWrites = new Map<string, number>();

  hasPending(pageId: string): boolean {
    return this.queues.has(pageId);
  }

  forget(pageId: string): void {
    this.unobservedWrites.delete(pageId);
  }

  deferLoad(pageId: string): boolean {
    const write = this.inFlight.get(pageId);
    if (!write) return false;
    write.reload = true;
    return true;
  }

  observe(event: LiveEvent): boolean {
    const { pageId, revision, origin } = event;
    const own = this.unobservedWrites.get(pageId);
    this.unobservedWrites.delete(pageId);
    if (own === revision && origin === 'api') return true;
    const write = this.inFlight.get(pageId);
    if (!write) return false;
    write.revision = revision;
    return true;
  }

  enqueue<T>(pageId: string, action: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(pageId) ?? Promise.resolve()).then(action);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(pageId, settled);
    void settled.then(() => {
      if (this.queues.get(pageId) === settled) this.queues.delete(pageId);
    });
    return result;
  }

  async put(pageId: string, request: {
    readonly draft: VaultDraft;
    readonly diagram?: DiagramWrite;
  }, state: WriteState): Promise<VaultDocument> {
    const pending: InFlightWrite = { reload: false };
    this.inFlight.set(pageId, pending);
    state.patchDraft({ saving: true });
    const { draft, diagram } = request;
    let saved: VaultDocument;
    try {
      saved = await putVaultDocument(pageId, {
        expectedRevision: draft.baseRevision,
        expectedVersion: draft.baseVersion,
        source: diagram?.source ?? draft.source,
        ...(diagram?.assets ? { assets: diagram.assets } : {}),
        ...(diagram?.references ? { references: diagram.references } : {})
      });
    } catch (error) {
      state.patchDraft({ saving: false, ...(pending.revision !== undefined ? { externalChange: true } : {}) });
      throw error;
    } finally {
      this.inFlight.delete(pageId);
    }

    // Ревизия — часть хеша. Сравниваем её только на равенство с последним событием.
    const revision = saved.page.revision;
    const reload = pending.reload || (pending.revision !== undefined && pending.revision !== revision);
    if (pending.revision === undefined && saved.version !== draft.baseVersion) {
      this.unobservedWrites.set(pageId, revision);
    }

    const latest = state.draft();
    state.publish(saved);
    if (latest) {
      const replaceSource = latest.epoch === draft.epoch && latest.source === draft.source;
      state.patchDraft({
        ...(replaceSource && { source: saved.source, epoch: latest.epoch + (diagram ? 1 : 0) }),
        baseRevision: revision,
        baseVersion: saved.version,
        saving: false,
        externalChange: reload || latest.conflict !== null
      });
    }
    // Диалог сначала применяет свою правку к истории редактора. Перечитываем после закрытия.
    if (reload && !latest?.modalOpen) state.reload();
    return saved;
  }
}

