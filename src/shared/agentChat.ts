/**
 * Wire-DTO встроенного чата агента (контракт: .agents/plan/agent-chat-contract.md).
 * Формы повторяют JSON-контракт REST-маршрутов `/api/vaults/{vaultId}/agent`;
 * реализация исполнителя — Rust (src-tauri), потребитель UI — src/web.
 * Файл реэкспортируется из types.ts, менять только согласованно с Serde-структурами.
 */

import type { DiagramFormat, WriteVaultDocumentBody } from './types.js';

// ---------------------------------------------------------------------------
// Примитивы
// ---------------------------------------------------------------------------

/** Нормализованный путь от корня vault; '' допустим только для корневой папки. */
export type AgentPath = string;

/** UUID объекта: разговор, сообщение агента, результат поиска. */
export type AgentId = string;

/** Версия содержимого: `sha256:<hex>`. */
export type AgentVersion = string;

/** Момент времени: ISO 8601 UTC. */
export type AgentTime = string;

/** Снимок документа или схемы, по которому агент читал и правил. */
export interface AgentBase {
  revision: number;
  version: AgentVersion;
}

/** Порядок поиска источников в сообщении. */
export type AgentSearchMode = 'docsFirst' | 'codeFirst';

// ---------------------------------------------------------------------------
// Контекст запроса: фокус редактора
// ---------------------------------------------------------------------------

/** Цель внутри диаграммы: файл целиком, вложение или диапазон UTF-16 в исходнике. */
export type AgentTarget =
  | { kind: 'file' }
  | { kind: 'asset'; path: AgentPath }
  | { kind: 'inline'; from: number; to: number };

/** Выделенный элемент диаграммы. pageId нужен для многоранищных draw.io. */
export interface AgentElementRef {
  id: string;
  kind: 'node' | 'edge' | 'element';
  pageId?: string;
}

/** Куда смотрит пользователь в момент отправки сообщения. */
export type AgentFocus =
  | { kind: 'folder'; folder: AgentPath }
  | { kind: 'document'; path: AgentPath; base: AgentBase }
  | {
      kind: 'diagram';
      path: AgentPath;
      base: AgentBase;
      format: DiagramFormat;
      target: AgentTarget;
      selected: AgentElementRef[];
      /** Оверлей редактора: исходник с наложенным черновиком, без записи на диск. */
      overlay?: WriteVaultDocumentBody;
    };

/** Сообщение пользователя; фокус захвачен в момент отправки и дальше не меняется. */
export interface AgentSubmit {
  id: AgentId;
  text: string;
  search: AgentSearchMode;
  focus: AgentFocus;
  /** Снимок настройки на момент отправки; transport retry не читает её повторно. */
  contextLimitTokens?: number;
}

// ---------------------------------------------------------------------------
// Результаты поиска и ссылки на источники
// ---------------------------------------------------------------------------

/**
 * Ссылка на источник ответа. vault и localCode различаются только смыслом,
 * поэтому объединены в один вариант.
 */
export type AgentCite =
  | { kind: 'vault' | 'localCode'; path: AgentPath; line: number }
  | { kind: 'remoteCode'; url: string; path: AgentPath; line: number }
  | { kind: 'confluence'; url: string; title: string };

/** Результат поиска: ссылка на источник и выдержка. */
export interface AgentHit {
  ref: AgentId;
  cite: AgentCite;
  excerpt: string;
}

/** Прочитанный фрагмент источника с его ссылкой. */
export interface AgentFragment {
  cite: AgentCite;
  text: string;
}

/** Параметры поиска: текст и лимит результатов. */
export interface AgentQuery {
  text: string;
  limit: number;
}

/** Диапазон строк источника; обе границы включены, нумерация с 1. */
export interface AgentLines {
  first: number;
  last: number;
}

// ---------------------------------------------------------------------------
// Разговоры и сообщения агента
// ---------------------------------------------------------------------------

/** Краткое описание разговора для списков — без содержимого. */
export interface AgentSessionSummary {
  id: AgentId;
  title: string;
  updatedAt: AgentTime;
}

/** Ошибка операции агента; конфликт дополнительно возвращает затронутые пути. */
export interface AgentFault {
  code: string;
  message: string;
  details?: { paths?: AgentPath[] };
}

/** Тело ошибки HTTP для маршрутов агента. */
export interface AgentErrorBody {
  error: AgentFault;
}

/** Фиксированные источники публичных действий в wire-протоколе. */
export type AgentProgressSource = 'vault' | 'localCode' | 'remoteCode' | 'confluence';

/** Место действия в хранилище. Нумерация строк начинается с 1. */
export interface AgentProgressTarget {
  readonly path: AgentPath;
  readonly line?: number;
  readonly pendingPublish?: boolean;
}

/** Публичное действие, которое агент уже начал; source уточняет конкретный источник. */
export interface AgentProgressEvent {
  kind: 'plan' | 'model' | 'verify' | 'search' | 'next_source' | 'read_vault' | 'read_source' | 'check' | 'stage' | 'commit';
  source?: AgentProgressSource;
  target?: AgentProgressTarget;
}

/** Фактические затраты и начатые действия запроса; не содержит промежуточных ответов модели. */
export interface AgentTurnProgress {
  stepsUsed: number;
  contextTokens: number;
  contextLimitTokens: number;
  events: AgentProgressEvent[];
}

/** Сообщение агента; финальные статусы несут ответ либо ошибку. */
export type AgentTurn =
  | { id: AgentId; text: string; at: AgentTime; status: 'running'; progress?: AgentTurnProgress }
  | {
      id: AgentId;
      text: string;
      at: AgentTime;
      status: 'done';
      answer: string;
      cites: AgentCite[];
      changed: AgentPath[];
      progress?: AgentTurnProgress;
    }
  | { id: AgentId; text: string; at: AgentTime; status: 'failed'; error: AgentFault; progress?: AgentTurnProgress }
  | { id: AgentId; text: string; at: AgentTime; status: 'interrupted'; error: AgentFault; progress?: AgentTurnProgress };

// ---------------------------------------------------------------------------
// Привязки исходников
// ---------------------------------------------------------------------------

/** Удалённый репозиторий; URL без userinfo, query и fragment. */
export interface AgentRepo {
  provider: 'gitlab' | 'github';
  url: string;
  ref?: string;
}

/** Привязка папки: репозиторий, локальная директория или оба источника. */
export interface AgentBinding {
  repo: AgentRepo | null;
  localDir: string | null;
}

/** Привязка папки с версией; null — привязки нет. */
export interface AgentBindingView {
  value: AgentBinding;
  version: AgentVersion | null;
}

/** Тело PUT привязки: форма отдаёт прочитанную версию для оптимистичной записи. */
export interface AgentBindingRequest extends AgentBindingView {
  folder: AgentPath;
}

// ---------------------------------------------------------------------------
// Подключения к модели и MCP-провайдерам
// ---------------------------------------------------------------------------

/** Слот подключения: модель или один из провайдеров чтения. */
export type AgentSlot = 'model' | 'confluence' | 'gitlab' | 'github';

/** OpenAI-совместимая модель либо MCP-провайдер чтения. */
export type AgentProfile =
  | { kind: 'model'; baseUrl: string; model: string }
  | { kind: Exclude<AgentSlot, 'model'>; endpoint: string; resourceHost: string };

/** Состояние подключения: профиль плюс результат последней проверки. */
export interface AgentConnection {
  profile: AgentProfile;
  state: 'missing' | 'ready' | 'expired' | 'unsupported';
}

/** Изменение секрета подключения; keep переносит секрет только при том же адресе. */
export type AgentSecretChange =
  | { kind: 'keep' }
  | { kind: 'clear' }
  | { kind: 'token'; value: string }
  | { kind: 'oauth'; clientId: string };

// ---------------------------------------------------------------------------
// Константы HTTP-протокола агента
// ---------------------------------------------------------------------------

/** Заголовок, обязательный для каждого маршрута агента. */
export const AGENT_HEADER = 'X-LiveNote-Agent';

/** Единственное допустимое значение AGENT_HEADER. */
export const AGENT_HEADER_VALUE = '1';

/** Путь OAuth-callback; единственный маршрут, доступный браузерной навигации. */
export const AGENT_OAUTH_CALLBACK_PATH = '/api/agent/oauth/callback';

/** База всех маршрутов агента для открытого vault; {vaultId} UI подставляет сам. */
export function agentApiBase(vaultId: string): string {
  return `/api/vaults/${encodeURIComponent(vaultId)}/agent`;
}
