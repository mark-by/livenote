/**
 * Сборка Express-приложения LiveNote:
 * security-мидлвари (Host/Origin, bearer-токен), REST, SSE, MCP и статика UI.
 */
import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LIVENOTE_VERSION } from '../shared/types.js';
import type { ApiConfig, AppConfig, LiveEvent } from '../shared/types.js';
import { NoteStore } from './db.js';
import type { PageStore } from './store.js';
import { DocumentProblem } from './vaultDocument.js';
import type { NoteService } from './services.js';
import { AppError, InvalidRequestError } from './errors.js';
import { createRestRouter } from './rest.js';
import { SseBroadcaster, createEventsRouter } from './sse.js';
import { mountMcp } from './mcp/mcpEndpoint.js';
import { createValidator } from './validator/index.js';
import { createBpmnValidator } from './validator/bpmn.js';
import { createDrawioValidator } from './validator/drawio.js';
import { StorageRuntime, VaultRegistry, vaultNotFound } from './vaultRegistry.js';
import type { SharedValidators } from './vaultRegistry.js';
import { VaultPicker } from './vaultPicker.js';
import type { ChooseFolder } from './vaultPicker.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** dist/server -> dist/web; при запуске tsx используется src/web/public/drawio. */
const STATIC_DIR = join(MODULE_DIR, '..', 'web');
const DRAWIO_BUILD_DIR = join(STATIC_DIR, 'drawio');
const DRAWIO_STATIC_DIR = existsSync(DRAWIO_BUILD_DIR) ? DRAWIO_BUILD_DIR : join(STATIC_DIR, 'public', 'drawio');

export interface RunningApp {
  app: Express;
  broadcaster: SseBroadcaster;
  service: NoteService;
  store: PageStore;
  close(): Promise<void>;
}

interface CreateAppOptions {
  readonly cacheHome?: string;
  readonly chooseFolder?: ChooseFolder;
  readonly closeGraceMs?: number;
}

function closeValidators(validators: SharedValidators): Promise<PromiseSettledResult<void>[]> {
  return Promise.allSettled(Object.values(validators).map(async candidate => {
    if ('close' in candidate && typeof candidate.close === 'function') {
      await candidate.close();
    } else if ('browser' in candidate) {
      const browser = candidate.browser;
      if (typeof browser === 'object' && browser !== null && 'close' in browser && typeof browser.close === 'function') {
        await browser.close();
      }
    }
  }));
}

export async function createApp(config: AppConfig, options: CreateAppOptions = {}): Promise<RunningApp> {
  const validators = {
    mermaid: await createValidator(config.mermaidTheme),
    bpmn: await createBpmnValidator(),
    drawio: await createDrawioValidator({ baseUrl: `http://127.0.0.1:${config.port}` })
  };
  const registry = config.vaultPath === undefined ? undefined :
    new VaultRegistry({ config, validators, cacheHome: options.cacheHome, closeGraceMs: options.closeGraceMs });
  const startup = await (async () => {
    if (registry !== undefined && config.vaultPath !== undefined) return registry.openStartup(config.vaultPath);
    const runtime = new StorageRuntime(new NoteStore(config.dbPath), new SseBroadcaster(), { config, validators });
    return { runtime, descriptor: undefined };
  })().catch(async (error: unknown) => {
    const cleanup = await closeValidators(validators);
    const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length > 0) throw new AggregateError([error, ...failures], 'Не удалось запустить приложение');
    throw error;
  });
  const { runtime, descriptor } = startup;
  const { store, broadcaster, deps } = runtime;
  const picker = new VaultPicker(registry, options.chooseFolder);

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
  const requireAuth = (allowQueryToken: boolean): RequestHandler => (req, res, next) => {
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (!authRequired || req.headers.authorization === `Bearer ${config.token}` || (allowQueryToken && queryToken === config.token)) {
      next();
      return;
    }
    res.status(401).json({
      error: { code: 'unauthorized', message: 'Требуется корректный bearer-токен' }
    });
  };

  // --- Каналы приложения ------------------------------------------------------
  app.get('/api/config', (_req, res) => {
    const apiConfig: ApiConfig = {
      version: LIVENOTE_VERSION,
      tokenRequired: authRequired,
      mermaidTheme: config.mermaidTheme,
      storage: descriptor === undefined ? 'sqlite' : 'vault',
      folderPickerAvailable: picker.available,
      ...(descriptor === undefined ? {} : { defaultVaultId: descriptor.id })
    };
    res.json(apiConfig);
  });

  app.post('/api/vaults/open', requireAuth(false), picker.guards, picker.parseBody, picker.handleOpen);
  app.use('/events', requireAuth(true), createEventsRouter(vaultId => {
    if (vaultId === undefined) return broadcaster;
    if (typeof vaultId !== 'string') throw new InvalidRequestError('Укажите один vault_id');
    if (registry === undefined) throw vaultNotFound(vaultId);
    return registry.lookup(vaultId).broadcaster;
  }));
  app.use('/api', requireAuth(true), express.json({ limit: '10mb' }));
  const restRouters = new WeakMap<StorageRuntime, Router>();
  app.use('/api/vaults/:vaultId', (req, res, next) => {
    const { vaultId } = req.params;
    if (registry === undefined) throw vaultNotFound(vaultId);
    const selected = registry.lookup(vaultId);
    const router = restRouters.get(selected) ?? createRestRouter(selected.deps);
    restRouters.set(selected, router);
    router(req, res, next);
  });
  app.use('/api', createRestRouter(deps));
  if (registry === undefined) mountMcp(app, deps);
  else mountMcp(app, deps, registry);

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
    if (error instanceof DocumentProblem) {
      res.status(400).json({ error: { code: 'invalid_request', message: error.message, details: { problem: error.code } } });
      return;
    }
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

  let closing: Promise<void> | undefined;
  return {
    app, broadcaster, service: deps.service, store,
    close() {
      return closing ??= (async () => {
        const storageClose = registry === undefined ? runtime.close() : registry.close();
        const storageResults = await Promise.allSettled([picker.close(), storageClose]);
        const validatorResults = await closeValidators(validators);
        const failures = [...storageResults, ...validatorResults]
          .filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length > 0) throw new AggregateError(failures, 'Не удалось завершить работу приложения');
      })();
    }
  };
}

/** Экспорт для типов, используемых в модулях-реализациях. */
export type { LiveEvent };
