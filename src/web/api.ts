/**
 * API-клиент веб-интерфейса LiveNote.
 * Обёртка над REST API сервера: подстановка bearer-токена, разбор ошибок,
 * единый обработчик «не авторизован».
 */
import type {
  ApiConfig,
  Block,
  LiveEvent,
  CreatePageBody,
  MoveVaultPageBody,
  PageFull,
  PageSummary,
  PatchVaultMetadataBody,
  RenderConfirmation,
  UpdatePagePatch,
  VaultDocument,
  VaultMoveResult,
  VaultSearchHit,
  VaultSnapshot,
  WriteBlockResult,
  WriteVaultDocumentBody
} from '../shared/types';

/** Ключ localStorage для bearer-токена. */
export const TOKEN_STORAGE_KEY = 'livenote_token';

/** Событие на window: токен протух/неверен — UI должен показать диалог ввода. */
export const UNAUTHORIZED_EVENT = 'livenote:unauthorized';

/** Ошибка API с машиночитаемым кодом (например 'unauthorized', 'conflict'). */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---------------------------------------------------------------------------
// Токен
// ---------------------------------------------------------------------------

/** Текущий токен из localStorage (может быть null). */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

/** Сохранить токен в localStorage. */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

/** Стереть токен (вызывается при 401). */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Низкоуровневая обёртка fetch
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Не разбирать ответ как JSON (для blob-скачиваний). */
  raw?: boolean;
}

/**
 * Выполнить запрос к API. Автоматически добавляет заголовок Authorization,
 * сериализует тело, разбирает ошибки {error:{code,message}}.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token !== null) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'Сеть недоступна',
      'network',
      0
    );
  }

  if (!response.ok) {
    let code = 'http_error';
    let message = `HTTP ${response.status}`;
    let details: unknown;
    try {
      const body = (await response.json()) as { error?: { code: string; message: string; details?: unknown } };
      if (body?.error) {
        code = body.error.code;
        message = body.error.message;
        details = body.error.details;
      }
    } catch {
      // тело не JSON — оставляем общий текст
    }
    // Токен не принят: стираем и сигнализируем UI, чтобы снова показать диалог ввода.
    if (code === 'unauthorized') {
      clearToken();
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(message, code, response.status, details);
  }

  if (options.raw === true) {
    return response as unknown as T;
  }
  // Ответы без тела (204 No Content у DELETE и rendered-подтверждения) — не JSON.
  const text = await response.text();
  if (text.trim() === '') {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Публичные методы REST API
// ---------------------------------------------------------------------------

/** GET /api/config — настройки до аутентификации (токен не требуется). */
export function getConfig(): Promise<ApiConfig> {
  return request<ApiConfig>('/api/config');
}

/** GET /api/pages — список страниц. */
export async function listPages(): Promise<PageSummary[]> {
  const body = await request<{ pages: PageSummary[] }>('/api/pages');
  return body.pages;
}

/** GET /api/pages/:id — страница целиком с блоками. */
export async function getPage(pageId: string): Promise<PageFull> {
  const body = await request<{ page: PageFull }>(`/api/pages/${encodeURIComponent(pageId)}`);
  return body.page;
}

/** POST /api/pages — создать страницу или документ vault. */
export async function createPage(titleOrBody: string | CreatePageBody): Promise<PageFull> {
  const body: CreatePageBody = typeof titleOrBody === 'string' ? { title: titleOrBody } : titleOrBody;
  const response = await request<{ page: PageFull }>('/api/pages', { method: 'POST', body });
  return response.page;
}

/** PATCH /api/pages/:id — переименовать / переупорядочить / удалить блоки. */
export async function updatePage(
  pageId: string,
  patch: UpdatePagePatch,
  expectedRevision: number
): Promise<PageFull> {
  const body = await request<{ page: PageFull }>(`/api/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    body: { ...patch, expectedRevision }
  });
  return body.page;
}

/** DELETE /api/pages/:id — удалить страницу. */
export async function deletePage(pageId: string, expectedRevision: number, expectedVersion?: string): Promise<void> {
  await request<unknown>(`/api/pages/${encodeURIComponent(pageId)}`, {
    method: 'DELETE',
    body: { expectedRevision, ...(expectedVersion === undefined ? {} : { expectedVersion }) }
  });
}

/** POST /api/pages/:id/blocks — создать блок. */
export async function createBlock(
  pageId: string,
  body: { type: Block['type']; source: string; expectedRevision: number; blockId?: string }
): Promise<WriteBlockResult> {
  const response = await request<{ page: PageFull; validation?: WriteBlockResult['validation'] }>(
    `/api/pages/${encodeURIComponent(pageId)}/blocks`,
    { method: 'POST', body }
  );
  const block = response.page.blocks.find((item) => item.id === body.blockId) ?? response.page.blocks.at(-1);
  return {
    pageId,
    blockId: block?.id ?? body.blockId ?? '',
    revision: response.page.revision,
    validation: response.validation
  };
}

/** PUT /api/pages/:id/blocks/:blockId — заменить содержимое блока. */
export async function updateBlock(
  pageId: string,
  blockId: string,
  body: { source: string; expectedRevision: number }
): Promise<WriteBlockResult> {
  const response = await request<{ page: PageFull; validation?: WriteBlockResult['validation'] }>(
    `/api/pages/${encodeURIComponent(pageId)}/blocks/${encodeURIComponent(blockId)}`,
    { method: 'PUT', body }
  );
  return {
    pageId,
    blockId,
    revision: response.page.revision,
    validation: response.validation
  };
}

/** DELETE /api/pages/:id/blocks/:blockId — удалить блок. */
export async function deleteBlock(
  pageId: string,
  blockId: string,
  expectedRevision: number
): Promise<PageFull> {
  const body = await request<{ page: PageFull }>(
    `/api/pages/${encodeURIComponent(pageId)}/blocks/${encodeURIComponent(blockId)}`,
    { method: 'DELETE', body: { expectedRevision } }
  );
  return body.page;
}

/** POST /api/pages/:id/blocks/:blockId/rendered — подтверждение фактического отображения. */
export function confirmRendered(
  pageId: string,
  blockId: string,
  confirmation: RenderConfirmation
): Promise<void> {
  return request<void>(
    `/api/pages/${encodeURIComponent(pageId)}/blocks/${encodeURIComponent(blockId)}/rendered`,
    { method: 'POST', body: confirmation }
  );
}

/** POST /api/import — импорт Markdown-документа в новую страницу. */
export function importMarkdown(body: { title?: string; content: string }): Promise<PageFull> {
  return request<PageFull>('/api/import', { method: 'POST', body });
}

/**
 * Скачать блок-диаграмму (mermaid/bpmn) PNG-файлом с прозрачным фоном.
 * Рендер выполняет серверный playwright-валидатор; при его недоступности —
 * ApiError с пояснением (SVG-скачивание остаётся рабочим).
 */
export async function downloadBlockPng(pageId: string, blockId: string, filename: string): Promise<void> {
  const response = await request<Response>(
    `/api/pages/${encodeURIComponent(pageId)}/blocks/${encodeURIComponent(blockId)}/png`,
    { raw: true }
  );
  const blob = await response.blob();
  downloadBlob(blob, filename);
}

// ---------------------------------------------------------------------------
// Vault: точные документы, метаданные, навигация и поиск
// ---------------------------------------------------------------------------

export async function getVaultSnapshot(): Promise<VaultSnapshot> {
  return request<VaultSnapshot>('/api/vault');
}

export async function getVaultDocument(pageId: string): Promise<VaultDocument> {
  const response = await request<{ document: VaultDocument }>(
    `/api/pages/${encodeURIComponent(pageId)}/document`
  );
  return response.document;
}

export async function putVaultDocument(
  pageId: string,
  body: WriteVaultDocumentBody
): Promise<VaultDocument> {
  const response = await request<{ document: VaultDocument }>(
    `/api/pages/${encodeURIComponent(pageId)}/document`,
    { method: 'PUT', body }
  );
  return response.document;
}

export async function patchVaultMetadata(
  pageId: string,
  body: PatchVaultMetadataBody
): Promise<VaultDocument> {
  const response = await request<{ document: VaultDocument }>(
    `/api/pages/${encodeURIComponent(pageId)}/metadata`,
    { method: 'PATCH', body }
  );
  return response.document;
}

export async function moveVaultPage(
  pageId: string,
  body: MoveVaultPageBody
): Promise<VaultMoveResult> {
  return request<VaultMoveResult>(
    `/api/pages/${encodeURIComponent(pageId)}/move`,
    { method: 'POST', body }
  );
}

export async function createVaultFolder(path: string, expectedTreeVersion: string): Promise<VaultSnapshot> {
  const response = await request<{ snapshot: VaultSnapshot }>('/api/vault/folders', {
    method: 'POST', body: { path, expectedTreeVersion }
  });
  return response.snapshot;
}

export async function moveVaultFolder(from: string, path: string, expectedTreeVersion: string): Promise<VaultMoveResult> {
  return request<VaultMoveResult>('/api/vault/folders/move', {
    method: 'POST', body: { from, path, expectedTreeVersion }
  });
}

export async function deleteVaultFolder(path: string, expectedTreeVersion: string, recursive: boolean): Promise<VaultSnapshot> {
  const response = await request<{ snapshot: VaultSnapshot }>('/api/vault/folders', {
    method: 'DELETE', body: { path, expectedTreeVersion, recursive }
  });
  return response.snapshot;
}

export async function searchVault(query: string, tag?: string): Promise<VaultSearchHit[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query);
  if (tag) params.set('tag', tag);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const response = await request<{ hits: VaultSearchHit[] }>(`/api/search${suffix}`);
  return response.hits;
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

/** URL для экспорта страницы (с query-токеном: ссылки не шлют заголовки). */
export function exportPageUrl(pageId: string): string {
  const token = getToken();
  const suffix = token !== null ? `?token=${encodeURIComponent(token)}` : '';
  return `/api/export/pages/${encodeURIComponent(pageId)}.md${suffix}`;
}

/** Скачать страницу в Markdown: fetch + blob + a.download (чтобы работал bearer-токен). */
export async function exportPage(pageId: string): Promise<void> {
  const response = await request<Response>(`/api/export/pages/${encodeURIComponent(pageId)}.md`, { raw: true });
  const blob = await response.blob();
  await downloadBlob(blob, 'page.md');
}

/** Скачать весь блокнот в Markdown: fetch + blob + a.download. */
export async function exportAll(): Promise<void> {
  const response = await request<Response>('/api/export/all.md', { raw: true });
  const blob = await response.blob();
  await downloadBlob(blob, 'livenote-export.md');
}

/** Подложить blob в <a download> и запустить скачивание. */
function downloadBlob(blob: Blob, suggestedName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Тип LiveEvent переэкспортируется рядом с API для удобства App.
// ---------------------------------------------------------------------------
export type { LiveEvent };
