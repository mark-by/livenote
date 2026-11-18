import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { AppConfig, DiagramValidator, VaultDescriptor } from '../shared/types.js';
import { AppError, InvalidRequestError, serverClosing } from './errors.js';
import type { ServerDeps } from './ports.js';
import { NoteService } from './services.js';
import type { PageStore } from './store.js';
import { SseBroadcaster } from './sse.js';
import type { BpmnValidator } from './validator/bpmn.js';
import { VaultStore } from './vault.js';
import { vaultCachePath, vaultIdForRoot } from './vaultIdentity.js';

const CLOSE_GRACE_MS = 30_000;

export interface SharedValidators {
  readonly mermaid: DiagramValidator;
  readonly bpmn: BpmnValidator;
  readonly drawio: DiagramValidator;
}

export function vaultNotFound(vaultId?: string): AppError {
  return new AppError('vault_not_found', 'Vault не открыт', 404, { vaultId });
}

export class StorageRuntime {
  readonly deps: ServerDeps;
  private readonly pending = new Set<Promise<unknown>>();
  private accepting = true;
  private closing?: Promise<void>;

  constructor(
    readonly store: PageStore,
    readonly broadcaster: SseBroadcaster,
    options: { readonly config: AppConfig; readonly validators: SharedValidators; readonly onIdle?: () => void }
  ) {
    const { mermaid, bpmn, drawio } = options.validators;
    const service = new NoteService(store, broadcaster, mermaid, bpmn, drawio);
    // HTTP-соединение может закрыться раньше, чем валидация и запись закончатся.
    // Учёт на границе NoteService одинаков для REST, MCP и прямых вызовов.
    const tracked = new Proxy(service, {
      get: (target, key) => {
        const member: unknown = Reflect.get(target, key);
        if (typeof member !== 'function' || key === 'constructor') return member;
        return (...args: unknown[]): unknown => {
          if (!this.accepting) throw serverClosing();
          const result: unknown = Reflect.apply(member, target, args);
          if (!(result instanceof Promise)) return result;
          this.pending.add(result);
          return result.finally(() => {
            this.pending.delete(result);
            if (this.idle) options.onIdle?.();
          });
        };
      }
    });
    this.deps = { service: tracked, broadcaster, config: options.config };
  }

  get idle(): boolean {
    return this.pending.size === 0;
  }

  close(): Promise<void> {
    this.accepting = false;
    return this.closing ??= this.drain();
  }

  private async drain(): Promise<void> {
    this.broadcaster.close();
    if (!this.idle) await Promise.allSettled(this.pending);
    this.store.close();
  }
}

interface VaultEntry {
  readonly root: string;
  readonly descriptor: VaultDescriptor;
  readonly runtime: StorageRuntime;
  readonly pinned: boolean;
  expiry?: NodeJS.Timeout;
  expired: boolean;
}

export class VaultRegistry {
  private readonly entries = new Map<string, VaultEntry>();
  private closing?: Promise<void>;
  private accepting = true;

  constructor(private readonly options: {
    readonly config: AppConfig;
    readonly validators: SharedValidators;
    readonly cacheHome?: string;
    readonly closeGraceMs?: number;
  }) {}

  openStartup(path: string): { readonly descriptor: VaultDescriptor; readonly runtime: StorageRuntime } {
    return this.open(path, true);
  }

  openSelected(path: string): VaultDescriptor {
    return this.open(path, false).descriptor;
  }

  list(): VaultDescriptor[] {
    return [...this.entries.values()].map(entry => entry.descriptor);
  }

  resolve(vaultId?: string): ServerDeps {
    if (vaultId !== undefined) return this.lookup(vaultId).deps;
    if (this.entries.size > 1) throw new AppError('vault_required', 'Укажите vault_id', 409);
    const entry = this.entries.values().next().value;
    if (entry === undefined) throw vaultNotFound();
    return entry.runtime.deps;
  }

  lookup(vaultId: string): StorageRuntime {
    const entry = this.entries.get(vaultId);
    if (entry === undefined) throw vaultNotFound(vaultId);
    return entry.runtime;
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.accepting = false;
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.closing = Promise.allSettled(entries.map(entry => {
      clearTimeout(entry.expiry);
      return entry.runtime.close();
    })).then(results => {
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'Не удалось закрыть vault');
    });
    return this.closing;
  }

  private open(path: string, pinned: boolean): VaultEntry {
    if (!this.accepting) throw serverClosing();
    if (pinned) mkdirSync(path, { recursive: true });
    // Канонизация и создание хранилища не уступают управление другому запросу.
    const root = realpathSync.native(path);
    if (!statSync(root).isDirectory()) throw new InvalidRequestError('Vault должен быть каталогом');
    const id = vaultIdForRoot(root);
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      if (existing.root !== root) throw new AppError('vault_id_collision', 'Идентификаторы vault совпали', 409);
      if (existing.runtime.broadcaster.clientCount === 0) this.scheduleExpiry(existing);
      return existing;
    }
    const descriptor = Object.freeze({ id, name: basename(root) || root });
    const broadcaster = new SseBroadcaster(count => {
      if (count === 0) this.scheduleExpiry(entry);
      else this.cancelExpiry(entry);
    });
    const cachePath = vaultCachePath(root, this.options.cacheHome);
    const store = new VaultStore(root, broadcaster, { cachePath });
    const runtime = new StorageRuntime(store, broadcaster, {
      config: { ...this.options.config, vaultPath: root },
      validators: this.options.validators,
      onIdle: () => this.retireIfIdle(entry)
    });
    const entry: VaultEntry = { root, descriptor, runtime, pinned, expired: false };
    this.entries.set(id, entry);
    this.scheduleExpiry(entry);
    return entry;
  }

  private cancelExpiry(entry: VaultEntry): void {
    clearTimeout(entry.expiry);
    entry.expiry = undefined;
    entry.expired = false;
  }

  private scheduleExpiry(entry: VaultEntry): void {
    if (entry.pinned || this.entries.get(entry.descriptor.id) !== entry) return;
    this.cancelExpiry(entry);
    entry.expiry = setTimeout(() => {
      entry.expiry = undefined;
      entry.expired = true;
      this.retireIfIdle(entry);
    }, this.options.closeGraceMs ?? CLOSE_GRACE_MS).unref();
  }

  private retireIfIdle(entry: VaultEntry): void {
    const { id } = entry.descriptor;
    if (!entry.expired || !entry.runtime.idle || this.entries.get(id) !== entry) return;
    this.entries.delete(id);
    // При отсутствии операций закрывает файловый lock до следующего вызова open.
    void entry.runtime.close().catch((error: unknown) => {
      console.error('[livenote] не удалось закрыть vault:', { id, error });
    });
  }
}
