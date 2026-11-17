/**
 * Подключение к каналу живых обновлений LiveNote (SSE /events).
 * SharedWorker делит один EventSource между вкладками. Потоки отдельных
 * вкладок исчерпывают лимит HTTP/1.1 и блокируют запросы сохранения.
 */
import type { LiveEvent, LiveEventName } from '../shared/types';
import { getToken } from './api';

/** Обработчики именованных событий канала. */
export interface EventHandlers {
  /** События модели — payload это LiveEvent. */
  onPageCreated?: (event: LiveEvent) => void;
  onPageUpdated?: (event: LiveEvent) => void;
  onPageDeleted?: (event: LiveEvent) => void;
  onPageMoved?: (event: LiveEvent) => void;
  onVaultUpdated?: (event: LiveEvent) => void;
  onBlockCreated?: (event: LiveEvent) => void;
  onBlockUpdated?: (event: LiveEvent) => void;
  onBlockDeleted?: (event: LiveEvent) => void;
  /** Серверное приветствие при установке соединения. */
  onHello?: (payload: unknown) => void;
  /** Соединение (пере)установлено — UI перечитывает данные. */
  onOpen?: () => void;
}

/** Имена событий, за которыми следит UI. */
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

export interface EventConnection {
  close(): void;
}

/**
 * Установить соединение с /events.
 * Токен передаётся query-параметром ?token= — EventSource не умеет заголовки.
 */
export function connectEvents(handlers: EventHandlers): EventConnection {
  const token = getToken();
  const url = token !== null ? `/events?token=${encodeURIComponent(token)}` : '/events';
  let worker: SharedWorker | null = null;

  const connect = (): void => {
    if (worker !== null) return;
    worker = new SharedWorker(new URL('./events.worker.ts', import.meta.url));
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
      } catch {
        // Битое сообщение не прерывает поток обновлений.
      }
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

  // При возврате из кэша навигации вкладка снова подписывается на события.
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
