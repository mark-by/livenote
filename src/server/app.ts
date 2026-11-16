/**
 * Сборка Express-приложения LiveNote:
 * security-мидлвари (Host/Origin, bearer-токен), REST, SSE, MCP и статика UI.
 */
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LIVENOTE_VERSION } from '../shared/types.js';
import type { AppConfig, LiveEvent } from '../shared/types.js';
import { NoteStore } from './db.js';
import { NoteService } from './services.js';
import { AppError } from './errors.js';
import type { ServerDeps } from './ports.js';
import { createRestRouter } from './rest.js';
import { SseBroadcaster, createEventsRouter } from './sse.js';
import { mountMcp } from './mcp/mcpEndpoint.js';
import { createValidator } from './validator/index.js';
import { createBpmnValidator } from './validator/bpmn.js';
import { createDrawioValidator } from './validator/drawio.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** dist/server -> dist/web; при запуске tsx используется src/web/public/drawio. */
const STATIC_DIR = join(MODULE_DIR, '..', 'web');
const DRAWIO_BUILD_DIR = join(STATIC_DIR, 'drawio');
const DRAWIO_STATIC_DIR = existsSync(DRAWIO_BUILD_DIR) ? DRAWIO_BUILD_DIR : join(STATIC_DIR, 'public', 'drawio');

export interface RunningApp {
  app: Express;
  broadcaster: SseBroadcaster;
  service: NoteService;
  store: NoteStore;
}

export async function createApp(config: import('../shared/types.js').AppConfig): Promise<RunningApp> {
  const store = new NoteStore(config.dbPath);
  const broadcaster = new SseBroadcaster();
  const validator = await createValidator(config.mermaidTheme);
  const bpmnValidator = await createBpmnValidator();
  const drawioValidator = await createDrawioValidator({ baseUrl: `http://127.0.0.1:${config.port}` });
  const service = new NoteService(store, broadcaster, validator, bpmnValidator, drawioValidator);
  const deps: ServerDeps = { service, broadcaster, config };

  const app = express();
  app.disable('x-powered-by');

  // --- Безопасность ---------------------------------------------------------
  // DNS rebinding: Host обязан быть локальным.
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').toLowerCase();
    const allowed = [`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`];
    if (!allowed.includes(host)) {
      return res.status(403).json({
        error: { code: 'forbidden_host', message: `Недопустимый Host "${host}" — LiveNote доступен только локально` }
      });
    }
    next();
  });

  // Origin: разрешаем только собственный UI и dev-сервер Vite.
  const allowedOrigins = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173'
  ]);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) {
      return res.status(403).json({
        error: { code: 'forbidden_origin', message: `Недопустимый Origin "${origin}"` }
      });
    }
    next();
  });

  // Bearer-токен для MCP и API (SSE принимает токен query-параметром из-за EventSource).
  const authRequired = config.token !== null && config.token.length > 0;
  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (!authRequired) {
      next();
      return;
    }
    const header = req.headers.authorization;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (header === `Bearer ${config.token}` || queryToken === config.token) {
      next();
      return;
    }
    res.status(401).json({
      error: { code: 'unauthorized', message: 'Требуется корректный bearer-токен' }
    });
  };

  // --- Каналы приложения ------------------------------------------------------
  app.get('/api/config', (req, res) => {
    res.json({ version: LIVENOTE_VERSION, tokenRequired: authRequired, mermaidTheme: config.mermaidTheme });
  });

  app.use('/events', requireAuth, createEventsRouter(deps));
  app.use('/api', requireAuth, express.json({ limit: '10mb' }), createRestRouter(deps));
  mountMcp(app, deps);

  // --- Статика UI + SPA fallback ---------------------------------------------
  // draw.io работает только с локальными ресурсами; внешние соединения запрещены CSP.
  app.use('/drawio', (req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'self' blob:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'"
      ].join('; ')
    );
    next();
  });
  app.use('/drawio', express.static(DRAWIO_STATIC_DIR));
  app.use('/drawio', (req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: `Ресурс draw.io "${req.path}" не найден` } });
  });

  const indexHtml = join(STATIC_DIR, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(express.static(STATIC_DIR));
    app.get('*', (req, res) => {
      // API-пути не отдаём как SPA: неизвестный API-маршрут — честный 404 JSON.
      // Иначе (как с любым новым эндпоинтом до перезапуска сервера) браузер
      // скачивает HTML-страницу в файле с чужим расширением.
      if (
        req.path.startsWith('/api/') ||
        req.path === '/events' ||
        req.path.startsWith('/events/') ||
        req.path === '/mcp' ||
        req.path.startsWith('/mcp/')
      ) {
        res.status(404).json({ error: { code: 'not_found', message: `Маршрут "${req.path}" не найден` } });
        return;
      }
      res.sendFile(indexHtml);
    });
  } else {
    app.get('/', (req, res) => {
      res
        .status(503)
        .send('Веб-интерфейс не собран. Выполните: npm run build (или npm run dev:web для разработки).');
    });
  }

  // --- Единый маппинг ошибок --------------------------------------------------
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.httpStatus).json({
        error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) }
      });
      return;
    }
    const message = error instanceof Error ? error.message : 'Внутренняя ошибка';
    console.error('[livenote] необработанная ошибка:', error);
    res.status(500).json({ error: { code: 'internal', message } });
  });

  return { app, broadcaster, service, store };
}

/** Экспорт для типов, используемых в модулях-реализациях. */
export type { LiveEvent };
