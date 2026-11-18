/**
 * SSE-канал живых обновлений (/events): рассылка событий агентских изменений
 * подключённым UI-клиентам. Монтируется в app.ts на /events, авторизация уже применена.
 */
import type { ServerResponse } from 'node:http';
import { Router } from 'express';
import { LIVENOTE_VERSION } from '../shared/types.js';
import type { Broadcaster, LiveEvent } from '../shared/types.js';
import { serverClosing } from './errors.js';

/** Интервал heartbeat-комментариев, чтобы соединение не рвалось на простоях. */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Рассылка событий по Server-Sent Events.
 * Единый набор клиентов и один общий heartbeat-таймер на всех.
 */
export class SseBroadcaster implements Broadcaster {
  private readonly clients = new Set<ServerResponse>();
  private closed = false;
  /** Общий таймер heartbeat; создаётся при первом клиенте, unref — не держит процесс. */
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly onClientCount?: (count: number) => void) {}

  get clientCount(): number {
    return this.clients.size;
  }

  publish(event: LiveEvent): void {
    // JSON.stringify экранирует переводы строк, поэтому data остаётся однострочной.
    this.broadcast(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  /** Регистрирует соединение после отправки приветствия. */
  addClient(res: ServerResponse): void {
    if (this.closed) throw serverClosing();
    if (res.writableEnded || res.destroyed) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    try {
      res.flushHeaders();
      res.write(
        `event: hello\ndata: ${JSON.stringify({ version: LIVENOTE_VERSION, ts: Date.now() })}\n\n`
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      res.destroy();
      return;
    }
    if (res.writableEnded || res.destroyed) return;
    res.once('close', () => this.removeClient(res));
    this.clients.add(res);
    this.ensureHeartbeat();
    this.onClientCount?.(this.clients.size);
  }

  removeClient(res: ServerResponse): void {
    if (!this.clients.delete(res)) return;
    if (this.clients.size === 0) this.stopHeartbeat();
    this.onClientCount?.(this.clients.size);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) {
      this.removeClient(client);
      if (!client.writableEnded && !client.destroyed) client.end();
    }
  }

  private broadcast(frame: string): void {
    for (const client of this.clients) {
      if (client.writableEnded || client.destroyed) {
        this.removeClient(client);
        continue;
      }
      try {
        client.write(frame);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        this.removeClient(client);
        client.destroy();
      }
    }
  }

  private ensureHeartbeat(): void {
    this.heartbeat ??= setInterval(() => this.broadcast(': ping\n\n'), HEARTBEAT_INTERVAL_MS).unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === null) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

/** GET /events регистрирует клиента в канале выбранного vault. */
export function createEventsRouter(selectBroadcaster: (vaultId: unknown) => SseBroadcaster): Router {
  const router = Router();
  router.head('/', (_req, res) => { res.status(405).set('Allow', 'GET').end(); });
  router.get('/', (req, res) => selectBroadcaster(req.query['vault_id']).addClient(res));
  return router;
}
