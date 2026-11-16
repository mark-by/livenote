/**
 * Контракты модулей, которые подключаются в app.ts.
 * Каждый модуль реализуется своей командой, поэтому сигнатуры зафиксированы здесь.
 */
import type { Express } from 'express';
import type { Broadcaster, LiveEvent } from '../shared/types.js';
import type { NoteService } from './services.js';
import type { AppConfig } from '../shared/types.js';

/** Общие зависимости REST/SSE/MCP-слоёв. */
export interface ServerDeps {
  service: NoteService;
  broadcaster: Broadcaster;
  config: AppConfig;
}

export type { Broadcaster, LiveEvent };
export type { NoteService };
export type { AppConfig };

// --- rest.ts: REST API для UI (/api/...) --------------------------------------
export function createRestRouter(deps: ServerDeps): Express['router'] {
  throw new Error('rest.ts ещё не реализован');
}

// --- sse.ts: канал живых обновлений (/events) и рассылка ----------------------
export class SseBroadcaster implements Broadcaster {
  publish(event: LiveEvent): void {
    throw new Error('sse.ts ещё не реализован');
  }
}

export function createEventsRouter(deps: ServerDeps): Express['router'] {
  throw new Error('sse.ts ещё не реализован');
}

// --- mcp/mcpEndpoint.ts: MCP на Streamable HTTP (/mcp) ------------------------
export function mountMcp(app: Express, deps: ServerDeps): void {
  throw new Error('mcp/mcpEndpoint.ts ещё не реализован');
}

// --- validator/index.ts: фабрика валидатора Mermaid ---------------------------
export function createValidator(): Promise<import('../shared/types.js').DiagramValidator> {
  throw new Error('validator/index.ts ещё не реализован');
}
