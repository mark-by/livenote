// allow: SIZE_OK — плоская таблица REST-маршрутов сохраняет существующие envelopes, auth и единый NoteService.
/**
 * REST API для веб-интерфейса. Монтируется в app.ts на /api:
 * bearer-авторизация и express.json уже применены выше по цепочке.
 * Слой тонкий: валидация формы запроса и вызовы NoteService;
 * ошибки AppError пробрасываются в общий error-handler (next).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DiagramValidation, PageFull, WriteLayout } from '../shared/types.js';
import { exportAllMarkdown, exportPageMarkdown } from './export.js';
import { InvalidRequestError, NotFoundError } from './errors.js';
import { parseMarkdownToBlocks } from './import.js';
import type { ServerDeps } from './ports.js';
import type { UpdatePageInput } from './services.js';
import { createSchema, deleteFolderSchema, documentSchema, folderSchema, moveFolderSchema, parseBody } from './vaultSchemas.js';

/** Тело запроса как JSON-объект (express.json уже распарсил его на /api). */
type JsonBody = Record<string, unknown>;

/**
 * Обёртка хендлеров: синхронные и async-ошибки в одном месте уходят в next,
 * где error-handler из app.ts мапит AppError в HTTP-статусы.
 */
function wrap(
  handler: (req: Request, res: Response) => void | Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void (async () => handler(req, res))().catch(next);
  };
}

/** Тело обязательно и должно быть JSON-объектом (не массив). */
function requireBody(req: Request): JsonBody {
  const body: unknown = req.body;
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidRequestError('Требуется JSON-тело запроса');
  }
  return body as JsonBody;
}

/** ID из параметров маршрута: роут сматчен, но под noUncheckedIndexedAccess тип — string | undefined. */
function requireParam(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new InvalidRequestError(`Не задан параметр маршрута "${name}"`);
  }
  return value;
}

/** Обязательное строковое поле тела. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidRequestError(`Поле "${field}" должно быть строкой`);
  }
  return value;
}

/** Необязательное строковое поле: отсутствует или не строка — undefined. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Необязательный режим раскладки BPMN: 'preserve' или 'auto'; отсутствует — undefined. */
function optionalLayout(value: unknown, field: string): WriteLayout | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'preserve' || value === 'auto') {
    return value;
  }
  throw new InvalidRequestError(`Поле "${field}" должно быть "preserve" или "auto"`);
}

/** Числовое поле: JSON-число, числовая строка тоже допускается (унафицировано с query). */
function requireNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new InvalidRequestError(`Поле "${field}" должно быть числом`);
}

/** Массив строк (blockOrder, deleteBlockIds). */
function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new InvalidRequestError(`Поле "${field}" должно быть массивом строк`);
  }
  return value as string[];
}

/**
 * expectedRevision для DELETE: тело может отсутствовать, тогда берём query-параметр
 (DELETE /pages/:id?expectedRevision=3). Нет валидного числа — InvalidRequestError.
 */
function requireExpectedRevision(body: JsonBody | undefined, req: Request): number {
  const raw = body?.expectedRevision ?? req.query.expectedRevision;
  return requireNumber(raw, 'expectedRevision');
}

/** Ответ на запись блока: страница плюс валидация, если она была. */
function pageResponse(
  page: PageFull,
  validation?: DiagramValidation
): { page: PageFull; validation?: DiagramValidation } {
  return validation !== undefined ? { page, validation } : { page };
}

/** Slug из названия страницы для имени файла при экспорте. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'page' : slug;
}

/**
 * Content-Disposition с ASCII-фолбэком и RFC 5987 для юникодных названий.
 */
function contentDisposition(slug: string): string {
  const ascii = slug.replace(/[^\x20-\x7E]/g, '_');
  return `attachment; filename="${ascii}.md"; filename*=UTF-8''${encodeURIComponent(slug)}.md`;
}

/** Собирает маршруты /api (пути относительны точки монтирования). */
export function createRestRouter(deps: ServerDeps): Router {
  const router = Router();
  const service = deps.service;

  // --- Страницы -------------------------------------------------------------

  // GET /pages — список страниц без содержимого.
  router.get(
    '/pages',
    wrap((req, res) => {
      res.json({ pages: service.listPages() });
    })
  );

  // POST /pages — создать страницу.
  router.post(
    '/pages',
    wrap(async (req, res) => {
      res.json({ page: await service.createDocument(parseBody(createSchema, req.body)) });
    })
  );

  router.get('/vault', wrap((_req, res) => { res.json(service.vaultSnapshot()); }));
  router.post('/vault/folders', wrap((req, res) => {
    const body = parseBody(folderSchema, req.body); res.json({ snapshot: service.createFolder(body.path, body.expectedTreeVersion) });
  }));
  router.post('/vault/folders/move', wrap((req, res) => {
    const body = parseBody(moveFolderSchema, req.body); res.json(service.moveFolder(body.from, body.path, body.expectedTreeVersion));
  }));
  router.delete('/vault/folders', wrap((req, res) => {
    const body = parseBody(deleteFolderSchema, req.body); res.json({ snapshot: service.deleteFolder(body.path, body.expectedTreeVersion, body.recursive) });
  }));
  router.get('/search', wrap((req, res) => {
    if ((req.query.q !== undefined && typeof req.query.q !== 'string') || (req.query.tag !== undefined && typeof req.query.tag !== 'string')) throw new InvalidRequestError('q и tag должны быть строками');
    res.json({ hits: service.search(optionalString(req.query.q) ?? '', optionalString(req.query.tag)) });
  }));
  router.get('/pages/:pageId/document', wrap((req, res) => {
    res.json({ document: service.getDocument(requireParam(req.params.pageId, 'pageId')) });
  }));
  router.put('/pages/:pageId/document', wrap(async (req, res) => {
    const document = await service.writeDocument(requireParam(req.params.pageId, 'pageId'), parseBody(documentSchema, req.body));
    res.json({ document });
  }));
  router.patch('/pages/:pageId/metadata', wrap((req, res) => {
    const body = requireBody(req);
    res.json({ document: service.patchMetadata(requireParam(req.params.pageId, 'pageId'), {
      expectedRevision: requireNumber(body.expectedRevision, 'expectedRevision'),
      expectedVersion: requireString(body.expectedVersion, 'expectedVersion'),
      ...(body.title !== undefined ? { title: requireString(body.title, 'title') } : {}),
      ...(body.aliases !== undefined ? { aliases: requireStringArray(body.aliases, 'aliases') } : {}),
      ...(body.tags !== undefined ? { tags: requireStringArray(body.tags, 'tags') } : {})
    }) });
  }));
  router.post('/pages/:pageId/move', wrap((req, res) => {
    const body = requireBody(req);
    res.json(service.movePage(requireParam(req.params.pageId, 'pageId'), {
      expectedRevision: requireNumber(body.expectedRevision, 'expectedRevision'),
      expectedVersion: requireString(body.expectedVersion, 'expectedVersion'),
      path: requireString(body.path, 'path')
    }));
  }));

  // GET /pages/:pageId — страница целиком (404 отдаёт error-handler через NotFoundError).
  router.get(
    '/pages/:pageId',
    wrap((req, res) => {
      res.json({ page: service.getPage(requireParam(req.params.pageId, 'pageId')) });
    })
  );

  // PATCH /pages/:pageId — переименование, порядок, удаление блоков за одну ревизию.
  router.patch(
    '/pages/:pageId',
    wrap((req, res) => {
      const pageId = requireParam(req.params.pageId, 'pageId');
      const body = requireBody(req);
      const expectedRevision = requireNumber(body.expectedRevision, 'expectedRevision');
      const patch: UpdatePageInput = {};
      if (body.title !== undefined) {
        patch.title = requireString(body.title, 'title');
      }
      if (body.blockOrder !== undefined) {
        patch.blockOrder = requireStringArray(body.blockOrder, 'blockOrder');
      }
      if (body.deleteBlockIds !== undefined) {
        patch.deleteBlockIds = requireStringArray(body.deleteBlockIds, 'deleteBlockIds');
      }
      res.json({ page: service.updatePage(pageId, patch, expectedRevision) });
    })
  );

  // DELETE /pages/:pageId — перенос в корзину; expectedRevision из тела или query.
  router.delete(
    '/pages/:pageId',
    wrap((req, res) => {
      const pageId = requireParam(req.params.pageId, 'pageId');
      const body: JsonBody | undefined = req.body === undefined ? undefined : requireBody(req);
      const expectedRevision = requireExpectedRevision(body, req);
      service.deletePage(pageId, expectedRevision, optionalString(body?.expectedVersion ?? req.query.expectedVersion));
      res.status(204).end();
    })
  );

  // --- Блоки ------------------------------------------------------------------

  // POST /pages/:pageId/blocks — создать или заменить блок (blockId опционален).
  router.post(
    '/pages/:pageId/blocks',
    wrap(async (req, res) => {
      const body = requireBody(req);
      const pageId = requireParam(req.params.pageId, 'pageId');
      const type = body.type;
      if (type !== 'markdown' && type !== 'mermaid' && type !== 'bpmn' && type !== 'drawio') {
        throw new InvalidRequestError('Поле "type" должно быть "markdown", "mermaid", "bpmn" или "drawio"');
      }
      const source = requireString(body.source, 'source');
      const expectedRevision = requireNumber(body.expectedRevision, 'expectedRevision');
      const blockId = optionalString(body.blockId);
      const requestId = optionalString(body.requestId);
      // layout применим только к bpmn-блокам: preserve — геометрия из XML, auto — автораскладка.
      const layout = type === 'bpmn' ? optionalLayout(body.layout, 'layout') : undefined;
      // title — название над схемой: отсутствует — не менять, пустая строка — убрать.
      const title = body.title === undefined ? undefined : requireString(body.title, 'title');
      const result = await service.writeBlock(
        pageId,
        blockId,
        type,
        source,
        expectedRevision,
        requestId,
        { layout, title, at: body.at === undefined ? undefined : requireNumber(body.at, 'at'), expectedVersion: optionalString(body.expectedVersion) }
      );
      res.json(pageResponse(service.getPage(pageId), result.validation));
    })
  );

  // PUT /pages/:pageId/blocks/:blockId — заменить существующий блок, не меняя его тип.
  router.put(
    '/pages/:pageId/blocks/:blockId',
    wrap(async (req, res) => {
      const body = requireBody(req);
      const pageId = requireParam(req.params.pageId, 'pageId');
      const blockId = requireParam(req.params.blockId, 'blockId');
      const source = requireString(body.source, 'source');
      const expectedRevision = requireNumber(body.expectedRevision, 'expectedRevision');
      // Тип берём у существующего блока, поэтому читаем страницу до записи.
      const current = service.getPage(pageId);
      const block = current.blocks.find((candidate) => candidate.id === blockId);
      if (!block) {
        throw new NotFoundError(`Блок "${blockId}" не найден на странице "${pageId}"`, {
          pageId,
          blockId
        });
      }
      const result = await service.writeBlock(pageId, blockId, block.type, source, expectedRevision, undefined, body.title === undefined ? {} : { title: requireString(body.title, 'title') });
      res.json(pageResponse(service.getPage(pageId), result.validation));
    })
  );

  // DELETE /pages/:pageId/blocks/:blockId — удалить блок.
  router.delete(
    '/pages/:pageId/blocks/:blockId',
    wrap((req, res) => {
      const body: JsonBody | undefined = req.body === undefined ? undefined : requireBody(req);
      const expectedRevision = requireExpectedRevision(body, req);
      const pageId = requireParam(req.params.pageId, 'pageId');
      const blockId = requireParam(req.params.blockId, 'blockId');
      const page = service.deleteBlock(pageId, blockId, expectedRevision);
      res.json({ page });
    })
  );

  // GET /pages/:pageId/blocks/:blockId/png — PNG с прозрачным фоном (headless-рендер).
  router.get(
    '/pages/:pageId/blocks/:blockId/png',
    wrap(async (req, res) => {
      const pageId = requireParam(req.params.pageId, 'pageId');
      const blockId = requireParam(req.params.blockId, 'blockId');
      const result = await service.checkDiagram(pageId, blockId, { mode: 'render', includeImage: true });
      const pngBase64 = result.render?.pngBase64;
      if (pngBase64 === undefined) {
        throw new InvalidRequestError(
          'PNG-экспорт недоступен: рендер-валидатор не поднят (запустите npx playwright install chromium)',
          { renderer: result.validation.renderer, syntax: result.validation.syntax }
        );
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename="${blockId}.png"`);
      res.send(Buffer.from(pngBase64, 'base64'));
    })
  );

  // POST .../rendered — подтверждение из UI, какая ревизия фактически отображается.
  router.post(
    '/pages/:pageId/blocks/:blockId/rendered',
    wrap((req, res) => {
      const body = requireBody(req);
      const revision = requireNumber(body.revision, 'revision');
      if (typeof body.ok !== 'boolean') {
        throw new InvalidRequestError('Поле "ok" должно быть boolean');
      }
      const error = optionalString(body.error);
      const pageId = requireParam(req.params.pageId, 'pageId');
      const blockId = requireParam(req.params.blockId, 'blockId');
      service.setRendered(pageId, blockId, {
        revision,
        ok: body.ok,
        ...(error !== undefined ? { error } : {})
      });
      res.status(204).end();
    })
  );

  // --- Экспорт / импорт -------------------------------------------------------

  // GET /export/pages/:pageId.md — страница в Markdown (диаграммы — fenced-блоками).
  router.get(
    '/export/pages/:pageId.md',
    wrap((req, res) => {
      const page = service.getPage(requireParam(req.params.pageId, 'pageId'));
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', contentDisposition(slugify(page.title)));
      res.send(deps.config.vaultPath !== undefined ? service.getDocument(page.id).source : exportPageMarkdown(page));
    })
  );

  // GET /export/all.md — весь блокнот одним документом.
  router.get('/export/all.zip', wrap((_req, res) => {
    res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', 'attachment; filename="livenote.zip"'); res.send(service.exportVault());
  }));
  router.get(
    '/export/all.md',
    wrap((req, res) => {
      if (deps.config.vaultPath !== undefined) {
        res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', 'attachment; filename="livenote.zip"'); res.send(service.exportVault()); return;
      }
      const pages = service.listPages().map((summary) => service.getPage(summary.id));
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', contentDisposition('livenote'));
      res.send(exportAllMarkdown(pages));
    })
  );

  // POST /import — Markdown-документ в новую страницу.
  router.post(
    '/import',
    wrap(async (req, res) => {
      const body = requireBody(req);
      const content = requireString(body.content, 'content');
      if (deps.config.vaultPath !== undefined) {
        res.json({ page: await service.createDocument({ title: optionalString(body.title) ?? 'Импортированная заметка', source: content, ...(body.path !== undefined ? { path: requireString(body.path, 'path') } : {}) }) });
        return;
      }
      const parsed = parseMarkdownToBlocks(content);
      // Явный title из запроса имеет приоритет над заголовком документа.
      const title = optionalString(body.title) ?? parsed.title;
      res.json({ page: await service.importPage(title, parsed.blocks) });
    })
  );

  return router;
}
