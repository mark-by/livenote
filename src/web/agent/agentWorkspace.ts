import type { AgentFocus, AgentProgressTarget } from '../../shared/types';

export interface AgentWorkspace {
  captureAgentFocus(): Promise<AgentFocus>;
  finishAgentTurn(changed: readonly string[]): Promise<void>;
  openPage(path: string): void;
  followAgentLocation(target: AgentProgressTarget, isCurrent: () => boolean): Promise<void>;
}

export interface AgentSessionDetails {
  readonly session: import('../../shared/types').AgentSessionSummary;
  readonly turns: import('../../shared/types').AgentTurn[];
}
