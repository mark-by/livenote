import type { LiveEvent, LiveEventName } from '../../shared/types';
import type { EventConnection, EventHandlers } from '../events';
import { getToken } from '../api';

const EVENT_NAMES: Array<{ name: LiveEventName; handler: keyof EventHandlers }> = [
  { name: 'page.created', handler: 'onPageCreated' },
  { name: 'page.updated', handler: 'onPageUpdated' },
  { name: 'page.deleted', handler: 'onPageDeleted' },
  { name: 'page.moved', handler: 'onPageMoved' },
  { name: 'vault.updated', handler: 'onVaultUpdated' },
  { name: 'block.created', handler: 'onBlockCreated' },
  { name: 'block.updated', handler: 'onBlockUpdated' },
  { name: 'block.deleted', handler: 'onBlockDeleted' }
];

export function connectVaultEvents(handlers: EventHandlers, vaultId: string | null): EventConnection {
  const params = new URLSearchParams();
  if (vaultId !== null) params.set('vault_id', vaultId);
  const token = getToken();
  if (token !== null) params.set('token', token);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const url = `/events${suffix}`;
  let worker: SharedWorker | null = null;

  const connect = (): void => {
    if (worker !== null) return;
    worker = new SharedWorker(new URL('../events.worker.ts', import.meta.url));
    worker.port.onmessage = ({ data }: MessageEvent<{ name: string; data?: string }>): void => {
      if (data.name === 'open') {
        handlers.onOpen?.();
        return;
      }
      if (data.name === 'hello') {
        try {
          handlers.onHello?.(JSON.parse(String(data.data)));
        } catch {
          handlers.onHello?.(undefined);
        }
        return;
      }
      const handler = EVENT_NAMES.find((event) => event.name === data.name)?.handler;
      if (!handler) return;
      try {
        const payload = JSON.parse(String(data.data)) as LiveEvent;
        handlers[handler]?.(payload);
      } catch {}
    };
    const names = ['hello', ...EVENT_NAMES.map((event) => event.name)];
    worker.port.postMessage({ type: 'connect', url, names });
  };

  const disconnect = (): void => {
    if (worker === null) return;
    worker.port.onmessage = null;
    worker.port.postMessage({ type: 'disconnect' });
    worker = null;
  };

  window.addEventListener('pagehide', disconnect);
  window.addEventListener('pageshow', connect);
  connect();

  return {
    close(): void {
      window.removeEventListener('pagehide', disconnect);
      window.removeEventListener('pageshow', connect);
      disconnect();
    }
  };
}
