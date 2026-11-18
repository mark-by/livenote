/**
 * Общий контракт LiveNote: модель данных, события SSE, DTO REST API и результаты MCP-инструментов.
 * Файл используется и сервером, и веб-интерфейсом. Менять только согласованно.
 */

/** Версия приложения — отделяется в /api/config и в MCP initialize. */
export const LIVENOTE_VERSION = '0.1.0';

/** Тип блока: обычный Markdown или диаграмма (Mermaid-текст, BPMN XML или draw.io XML). */
export type BlockType = 'markdown' | 'mermaid' | 'bpmn' | 'drawio';

/** Формат диаграммы для write_diagram. */
export type DiagramFormat = 'mermaid' | 'bpmn' | 'drawio';

/**
 * Режим раскладки BPMN при записи:
 * - preserve — использовать геометрию BPMNDI из переданного XML;
 * - auto — пересчитать раскладку (ручное расположение может измениться).
 */
export type WriteLayout = 'preserve' | 'auto';

/**
 * Блок внутри страницы.
 * source — чистый текст: для markdown — исходник Markdown,
 * для mermaid — чистый Mermaid БЕЗ ограждения ```mermaid.
 */
export interface Block {
  /** SQLite: стабильный ID. Vault: временный span-N только данной ревизии, на диск не записывается. */
  id: string;
  pageId: string;
  type: BlockType;
  source: string;
  /** Название диаграммы, отображается HTML-заголовком НАД схемой (вне SVG). Для markdown — null. */
  title: string | null;
  /** Порядок отображения на странице (0..N-1). */
  position: number;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
  /** Ревизия страницы, фактически отображённая в открытом UI (подтверждение rendered_revision). */
  renderedRevision: number | null;
  /** Успешно ли отрисовался последний подтверждённый вариант в UI. */
  renderOk: boolean | null;
  /** Ошибка последнего рендера в UI, если была. */
  renderError: string | null;
}

/** Краткое описание страницы для списков — без содержимого. */
export interface PageSummary {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Страница целиком, со всеми блоками в порядке отображения. */
export interface PageFull extends PageSummary {
  blocks: Block[];
}

// ---------------------------------------------------------------------------
// Валидация Mermaid
// ---------------------------------------------------------------------------

/** Статус проверки синтаксиса диаграммы. */
export type ValidationStatus = 'ok' | 'error' | 'not_checked';

/** Кто выполнил проверку: headless-браузер, открытый UI или никто. */
export type RendererKind = 'playwright' | 'ui' | 'unavailable';

export interface DiagramError {
  message: string;
  /** Номер строки, если Mermaid его сообщает. */
  line?: number;
}

/** Замечание bpmnlint: не блокирует публикацию, но агенту стоит учесть. */
export interface BpmnLintIssue {
  rule: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
}

/** Результат проверки диаграммы. Честно разделяет «синтаксис ок» и «кто проверял». */
export interface DiagramValidation {
  syntax: ValidationStatus;
  renderer: RendererKind;
  /** Тип диаграммы (flowchart, sequenceDiagram, ...) при успешном parse. */
  diagramType?: string;
  error?: DiagramError;
  /** Неблокирующее предупреждение (например, «раскладка пересчитана»). */
  warning?: string;
  /** Только BPMN: замечания bpmnlint. */
  lint?: BpmnLintIssue[];
  /** Только BPMN: есть ли в XML геометрия BPMNDI. */
  hasDiagram?: boolean;
}

/** Результат рендеринга: SVG и (опционально) PNG-скриншот. */
export interface DiagramRenderResult {
  svg: string;
  /** Base64 PNG — заполняется при includeImage (REST-эндпоинт скачивания PNG). */
  pngBase64?: string;
  width?: number;
  height?: number;
}

/** Порт валидатора: реализация на Playwright с деградацией до unavailable. */
export interface DiagramValidator {
  readonly kind: RendererKind;
  /** Проверка синтаксиса без рендеринга (mermaid.parse). */
  parse(source: string): Promise<DiagramValidation>;
  /** Полный рендеринг; pngBase64 — при includeImage. */
  render(
    source: string,
    options?: { includeImage?: boolean; theme?: MermaidTheme }
  ): Promise<{ validation: DiagramValidation; render?: DiagramRenderResult }>;
}

// ---------------------------------------------------------------------------
// Результаты операций записи
// ---------------------------------------------------------------------------

/**
 * Результат write_markdown / write_diagram.
 * Если валидация Mermaid провалилась, новая версия НЕ публикуется:
 * revision в ответе — текущая (не изменившаяся) ревизия страницы.
 */
export interface WriteBlockResult {
  pageId: string;
  blockId: string;
  /** Ревизия страницы после операции. */
  revision: number;
  /** Присутствует только для диаграммных блоков. */
  validation?: DiagramValidation;
}

/** Результат check_diagram. */
export interface CheckDiagramResult {
  pageId: string;
  blockId: string;
  /** Актуальная ревизия страницы. */
  revision: number;
  /** true — запрошенная ревизия устарела, проверка не выполнялась, перечитайте страницу. */
  stale: boolean;
  validation: DiagramValidation;
  render?: DiagramRenderResult;
}

// ---------------------------------------------------------------------------
// События живого обновления (SSE /events)
// ---------------------------------------------------------------------------

export type LiveEventName =
  | 'page.created'
  | 'page.updated'
  | 'page.deleted'
  | 'page.moved'
  | 'vault.updated'
  | 'block.created'
  | 'block.updated'
  | 'block.deleted';

/** Лёгкое событие для UI: полные данные UI добирает GET-ом по pageId. */
export interface LiveEvent {
  previousPath?: string;
  origin?: 'api' | 'external';
  event: LiveEventName;
  pageId: string;
  /** Ревизия страницы после изменения. */
  revision: number;
  /** ID затронутого блока, если событие блочное. */
  blockId?: string;
  /** Epoch ms — для отладки и сортировки. */
  ts: number;
}

/** Порт рассылки событий подключённым клиентам UI. */
export interface Broadcaster {
  publish(event: LiveEvent): void;
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

/** Формат ошибки REST API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Тема mermaid для отрисовки диаграмм — задаётся флагом --theme сервера. */
export const MERMAID_THEMES = [
  'default',
  'base',
  'dark',
  'forest',
  'neutral',
  'neo',
  'neo-dark',
  'redux',
  'redux-dark',
  'redux-color',
  'redux-dark-color'
] as const;

export type MermaidTheme = (typeof MERMAID_THEMES)[number];

export interface VaultDescriptor {
  readonly id: string;
  readonly name: string;
}

/** Тело GET /api/config — настройки, нужные UI до аутентификации. */
export interface ApiConfig {
  storage?: 'vault' | 'sqlite';
  readonly defaultVaultId?: string;
  readonly folderPickerAvailable?: boolean;
  version: string;
  tokenRequired: boolean;
  mermaidTheme: MermaidTheme;
}

/** PATCH /api/pages/:id — переименование, порядок блоков, удаление блоков. */
export interface UpdatePagePatch {
  title?: string;
  /** Новый порядок: массив block id, ровно по оставшимся блокам страницы. */
  blockOrder?: string[];
  /** ID блоков, которые нужно удалить. */
  deleteBlockIds?: string[];
}

/** POST /api/pages/:id/blocks/:blockId/rendered — подтверждение фактического отображения в UI. */
export interface RenderConfirmation {
  /** Ревизия страницы, версия которой была отрисована. */
  revision: number;
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Импорт / экспорт
// ---------------------------------------------------------------------------

/** POST /api/import — разбор Markdown в страницу. */
export interface ImportMarkdownBody {
  title?: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Конфигурация сервера
// ---------------------------------------------------------------------------

export interface AppConfig {
  port: number;
  /** Всегда 127.0.0.1 — наружу не слушаем. */
  host: '127.0.0.1';
  dbPath: string;
  vaultPath?: string;
  /** Bearer-токен для /mcp и /api. null — аутентификация отключена. */
  token: string | null;
  openBrowser: boolean;
  /** Тема mermaid для отрисовки диаграмм в UI и в валидаторе. */
  mermaidTheme: MermaidTheme;
}

// ---------------------------------------------------------------------------
// Вспомогательные правила
// ---------------------------------------------------------------------------

/**
 * Допустимые ID страниц и блоков: латиница, цифры, дефис, подчёркивание.
 * Смысловые ID от агента (например "main-flow") — приветствуются.
 */
export const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Длина сокращённого автосгенерированного ID. */
export const SHORT_ID_LENGTH = 8;

export type VaultProblemCode =
  | 'missing_id' | 'invalid_frontmatter' | 'duplicate_page_id'
  | 'invalid_block' | 'duplicate_block_id' | 'missing_asset'
  | 'unsafe_path' | 'git_conflict' | 'unreadable_file';

export interface VaultProblem {
  code: VaultProblemCode;
  path: string;
  message: string;
  pageId?: string;
  blockId?: string;
}

export interface VaultPageSummary extends PageSummary {
  path: string;
  aliases: string[];
  tags: string[];
}

export interface VaultLink {
  target: string;
  targetPageId: string | null;
  label: string | null;
  kind: 'wiki' | 'markdown';
  fragment: string | null;
}

export interface VaultBacklink {
  pageId: string;
  title: string;
  path: string;
}

export interface VaultAsset {
  type: DiagramFormat;
  path: string;
  source: string | null;
  version: string | null;
}

export interface SourceRange { from: number; to: number }

export interface VaultSourceSpan extends SourceRange {
  blockId: string;
  type: BlockType;
  sourceFrom: number;
  sourceTo: number;
  assetPath?: string;
}

export interface VaultDocument {
  page: PageFull;
  path: string;
  source: string;
  version: string;
  spans: VaultSourceSpan[];
  aliases: string[];
  tags: string[];
  assets: VaultAsset[];
  links: VaultLink[];
  backlinks: VaultBacklink[];
}

export interface VaultSnapshot {
  readonly vaultName?: string;
  pages: VaultPageSummary[];
  files: Array<{ path: string; kind: 'markdown' | DiagramFormat; title: string; version: string; revision: number }>;
  folders: string[];
  treeVersion: string;
  tags: Array<{ tag: string; count: number }>;
  problems: VaultProblem[];
}

export interface WriteVaultDocumentBody {
  expectedRevision: number;
  expectedVersion: string;
  source: string;
  assets?: Array<{ path: string; source: string; expectedVersion: string | null; layout?: WriteLayout }>;
  references?: Array<{ path: string; expectedVersion: string }>;
  requestId?: string;
}

export interface PatchVaultMetadataBody {
  expectedRevision: number;
  expectedVersion: string;
  title?: string;
  aliases?: string[];
  tags?: string[];
}

export interface MoveVaultPageBody {
  expectedRevision: number;
  expectedVersion: string;
  path: string;
}

export interface VaultMoveResult {
  document?: VaultDocument;
  moved: Array<{ from: string; to: string }>;
  updatedPaths: string[];
  treeVersion: string;
}

export interface VaultSearchHit {
  pageId: string;
  title: string;
  path: string;
  tags: string[];
  excerpt: string;
}

export interface VaultConflictDetails {
  currentRevision: number;
  currentVersion?: string;
  currentTreeVersion?: string;
  reason?: 'stale' | 'missing' | 'document_problem' | 'destination_exists' | 'transaction_incomplete';
  paths?: string[];
  problems?: VaultProblem[];
}

export interface CreatePageBody {
  title: string;
  requestId?: string;
  path?: string;
  source?: string;
  format?: DiagramFormat;
  aliases?: string[];
  tags?: string[];
}
