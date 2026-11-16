/**
 * SSE-канал живых обновлений (/events): рассылка событий агентских изменений
 * подключённым UI-клиентам. Монтируется в app.ts на /events, авторизация уже применена.
 */
import type { ServerResponse } from 'node:http';
import { Router } from 'express';
import { LIVENOTE_VERSION } from '../shared/types.js';
import type { Broadcaster, LiveEvent } from '../shared/types.js';
import type { ServerDeps } from './ports.js';

/** Интервал heartbeat-комментариев, чтобы соединение не рвалось на простоях. */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Рассылка событий по Server-Sent Events.
 * Единый набор клиентов и один общий heartbeat-таймер на всех.
 */
export class SseBroadcaster implements Broadcaster {
  private readonly clients = new Set<ServerResponse>();
  /** Общий таймер heartbeat; создаётся при первом клиенте, unref — не держит процесс. */
  private heartbeat: NodeJS.Timeout | null = null;

  publish(event: LiveEvent): void {
    // JSON.stringify экранирует переводы строк, поэтому data остаётся однострочной.
    const frame = `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of [...this.clients]) {
      if (client.writableEnded || client.destroyed) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.write(frame);
      } catch {
        // Запись в закрытое соединение — убираем клиента из набора.
        this.clients.delete(client);
      }
    }
  }

  /** Подключить клиента: SSE-заголовки, приветствие, отписка по закрытию запроса. */
  addClient(res: ServerResponse): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    try {
      res.write(
        `event: hello\ndata: ${JSON.stringify({ version: LIVENOTE_VERSION, ts: Date.now() })}\n\n`
      );
    } catch {
      // Соединение умерло ещё до приветствия — не регистрируем.
      this.clients.delete(res);
      return;
    }
    res.req.once('close', () => {
      this.removeClient(res);
    });
    this.clients.add(res);
    this.ensureHeartbeat();
  }

  removeClient(res: ServerResponse): void {
    this.clients.delete(res);
  }

  /** Один общий heartbeat: пишет `: ping` всем, подчищая битые соединения. */
  private ensureHeartbeat(): void {
    if (this.heartbeat !== null) {
      return;
    }
    this.heartbeat = setInterval(() => {
      for (const client of [...this.clients]) {
        if (client.writableEnded || client.destroyed) {
          this.clients.delete(client);
          continue;
        }
        try {
          client.write(': ping\n\n');
        } catch {
          this.clients.delete(client);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    // Таймер не должен мешать завершению процесса после закрытия сервера.
    this.heartbeat.unref();
  }
}

/**
 * GET /events — регистрирует клиента в SseBroadcaster.
 * deps.broadcaster приходит именно экземпляром SseBroadcaster (сборка в app.ts).
 */
export function createEventsRouter(deps: ServerDeps): Router {
  const router = Router();
  router.get('/', (req, res) => {
    const broadcaster = deps.broadcaster as SseBroadcaster;
    broadcaster.addClient(res);
  });
  return router;
}
