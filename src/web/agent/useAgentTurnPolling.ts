import { useEffect, useRef } from 'react';
import type { AgentFault, AgentTurn } from '../../shared/types';
import { getAgentTurn } from './agentApi';
import type { AgentSessionDetails } from './agentWorkspace';

interface PollingOptions {
  readonly vaultId: string;
  readonly details: Readonly<Record<string, AgentSessionDetails>>;
  readonly onTurn: (sessionId: string, turn: AgentTurn) => Promise<void>;
  readonly onError: (fault: AgentFault) => void;
  readonly fault: (error: unknown) => AgentFault;
}

const delay = 650;

export function useAgentTurnPolling({ vaultId, details, onTurn, onError, fault }: PollingOptions): void {
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const running = Object.entries(details).flatMap(([sessionId, detail]) => detail.turns
    .filter(turn => turn.status === 'running').map(turn => `${sessionId}:${turn.id}`));
  const signature = running.join('|');
  useEffect(() => {
    if (signature === '') return;
    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      const pending = Object.entries(detailsRef.current).flatMap(([sessionId, detail]) => detail.turns
        .filter(turn => turn.status === 'running').map(turn => ({ sessionId, turnId: turn.id })));
      let repeat = false;
      await Promise.all(pending.map(async ({ sessionId, turnId }) => {
        try {
          const turn = await getAgentTurn(vaultId, sessionId, turnId);
          if (active) await onTurn(sessionId, turn);
          if (turn.status === 'running') repeat = true;
        } catch (error) {
          repeat = true;
          if (active) onError(fault(error));
        }
      }));
      if (active && repeat) timer = window.setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [fault, onError, onTurn, signature, vaultId]);
}
