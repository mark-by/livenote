import type { LiveEvent, LiveEventName } from '../shared/types';
import type { EventConnection, EventHandlers } from './events';

type ModelHandler = Exclude<keyof EventHandlers, 'onHello' | 'onOpen'>;
export type EventNames = ReadonlyArray<{ name: LiveEventName; handler: ModelHandler }>;

export const EVENT_NAMES: EventNames = [
  { name: 'page.created', handler: 'onPageCreated' },
  { name: 'page.updated', handler: 'onPageUpdated' },
  { name: 'page.deleted', handler: 'onPageDeleted' },
  { name: 'page.moved', handler: 'onPageMoved' },
  { name: 'vault.updated', handler: 'onVaultUpdated' },
  { name: 'block.created', handler: 'onBlockCreated' },
  { name: 'block.updated', handler: 'onBlockUpdated' },
  { name: 'block.deleted', handler: 'onBlockDeleted' }
];

export function connectEventPort(url: string, events: EventNames, handlers: EventHandlers): EventConnection {
  let worker: SharedWorker | null = null;

  const connect = (): void => {
    if (worker !== null) return;
    worker = new SharedWorker(new URL('./events.worker.ts', import.meta.url));
    worker.port.onmessage = ({ data }: MessageEvent<{ name: string; data?: string }>): void => {
      if (data.name === 'open') {
        handlers.onOpen?.();
        return;
      }
      const handler = events.find((event) => event.name === data.name)?.handler;
      if (data.name !== 'hello' && handler === undefined) return;

      let payload: unknown;
      try {
        payload = JSON.parse(String(data.data));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (data.name === 'hello') handlers.onHello?.(undefined);
        return;
      }

      if (data.name === 'hello') {
        handlers.onHello?.(payload);
      } else if (handler !== undefined) {
        handlers[handler]?.(payload as LiveEvent);
      }
    };
    const names = ['hello', ...events.map((event) => event.name)];
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
