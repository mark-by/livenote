import type { AgentSearchMode } from '../../shared/types';

export interface AgentPanelPreferences {
  readonly open: boolean;
  readonly followAgent: boolean;
  readonly width: number;
  readonly sessionId: string | null;
  readonly drafts: Readonly<Record<string, string>>;
  readonly contextLimitTokens: number;
  readonly search: AgentSearchMode;
}

export const AGENT_MIN_WIDTH = 280;
export const AGENT_MAX_WIDTH = 640;
export const AGENT_DEFAULT_WIDTH = 384;
export const AGENT_RESIZE_STEP = 16;
export const AGENT_MIN_CONTEXT_LIMIT_TOKENS = 8192;
export const AGENT_MAX_CONTEXT_LIMIT_TOKENS = 1048576;
export const AGENT_DEFAULT_CONTEXT_LIMIT_TOKENS = 65536;

export function clampAgentWidth(width: number): number {
  return Math.max(AGENT_MIN_WIDTH, Math.min(AGENT_MAX_WIDTH, Math.round(width)));
}

export function isAgentContextLimitTokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= AGENT_MIN_CONTEXT_LIMIT_TOKENS && value <= AGENT_MAX_CONTEXT_LIMIT_TOKENS;
}

const key = (vaultId: string): string => `livenote_agent_panel:${encodeURIComponent(vaultId)}`;

export function loadAgentPreferences(vaultId: string): AgentPanelPreferences {
  const fallback: AgentPanelPreferences = {
    open: false, followAgent: false, width: AGENT_DEFAULT_WIDTH, sessionId: null, drafts: {},
    contextLimitTokens: AGENT_DEFAULT_CONTEXT_LIMIT_TOKENS, search: 'docsFirst'
  };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(vaultId)) ?? 'null');
    if (typeof value !== 'object' || value === null) return fallback;
    const record: Record<string, unknown> = { ...value };
    const drafts: Record<string, string> = {};
    if (typeof record['drafts'] === 'object' && record['drafts'] !== null) {
      for (const [id, draft] of Object.entries(record['drafts'])) if (typeof draft === 'string') drafts[id] = draft;
    }
    const contextLimitTokens = record['contextLimitTokens'];
    return {
      open: record['open'] === true,
      followAgent: record['followAgent'] === true,
      width: typeof record['width'] === 'number' && Number.isFinite(record['width']) ? clampAgentWidth(record['width']) : AGENT_DEFAULT_WIDTH,
      sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : null,
      drafts,
      contextLimitTokens: isAgentContextLimitTokens(contextLimitTokens) ? contextLimitTokens : AGENT_DEFAULT_CONTEXT_LIMIT_TOKENS,
      search: record['search'] === 'codeFirst' ? 'codeFirst' : 'docsFirst'
    };
  } catch { return fallback; }
}

export function saveAgentPreferences(vaultId: string, preferences: AgentPanelPreferences): void {
  localStorage.setItem(key(vaultId), JSON.stringify(preferences));
}
