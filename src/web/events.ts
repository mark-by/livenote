/**
 * Подключение к каналу живых обновлений LiveNote (SSE /events).
 * SharedWorker делит один EventSource между вкладками. Потоки отдельных
 * вкладок исчерпывают лимит HTTP/1.1 и блокируют запросы сохранения.
 */
import type { LiveEvent } from '../shared/types';
import { getToken } from './api';
import { connectEventPort, EVENT_NAMES } from './eventDelivery';

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
  return connectEventPort(url, EVENT_NAMES, handlers);
}
