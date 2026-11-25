import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentFault, AgentSearchMode, AgentSessionSummary, AgentSubmit, AgentTurn
} from '../../shared/types';
import {
  createAgentSession, getAgentSession, listAgentSessions, submitAgentTurn
} from './agentApi';
import { agentFault } from './agentFault';
import {
  AGENT_DEFAULT_CONTEXT_LIMIT_TOKENS, AGENT_DEFAULT_WIDTH, loadAgentPreferences, saveAgentPreferences
} from './agentStorage';
import type { AgentSessionDetails, AgentWorkspace } from './agentWorkspace';
import { useAgentTurnPolling } from './useAgentTurnPolling';

interface AgentChatOptions {
  readonly vaultId: string | null;
  readonly workspace: AgentWorkspace;
  readonly enabled: boolean;
}

export function useAgentChat({ vaultId, workspace, enabled }: AgentChatOptions) {
  const [preferences] = useState(() => vaultId === null ? null : loadAgentPreferences(vaultId));
  const [open, setOpen] = useState(preferences?.open ?? true);
  const [followAgent, setFollowAgent] = useState(preferences?.followAgent ?? false);
  const [width, setWidth] = useState(preferences?.width ?? AGENT_DEFAULT_WIDTH);
  const [selectedId, setSelectedId] = useState<string | null>(preferences?.sessionId ?? null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>(preferences?.drafts ?? {});
  const [contextLimitTokens, setContextLimitTokens] = useState(
    preferences?.contextLimitTokens ?? AGENT_DEFAULT_CONTEXT_LIMIT_TOKENS
  );
  const [search, setSearch] = useState<AgentSearchMode>(preferences?.search ?? 'docsFirst');
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [details, setDetails] = useState<Readonly<Record<string, AgentSessionDetails>>>({});
  const [error, setError] = useState<AgentFault | null>(null);
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [creating, setCreating] = useState(false);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const followRef = useRef({ active: false, sessionId: selectedId });
  followRef.current = { active: enabled && open && followAgent, sessionId: selectedId };
  const submittedRef = useRef<{ id: string; seenLocation: string | undefined } | null>(null);
  const finalizedRef = useRef(new Set<string>());

  const showError = useCallback((fault: AgentFault): void => setError(fault), []);
  const refreshSessions = useCallback(async (): Promise<void> => {
    if (vaultId === null) return;
    const fresh = await listAgentSessions(vaultId);
    setSessions(fresh);
    setSelectedId(current => current !== null && fresh.some(item => item.id === current) ? current : fresh[0]?.id ?? null);
  }, [vaultId]);

  useEffect(() => {
    if (!enabled || vaultId === null) return;
    let active = true;
    setReady(false);
    void listAgentSessions(vaultId).then(freshSessions => {
      if (!active) return;
      setSessions(freshSessions);
      setSelectedId(current => current !== null && freshSessions.some(item => item.id === current) ? current : freshSessions[0]?.id ?? null);
      setReady(true);
    }).catch((loadError: unknown) => {
      if (active) {
        setError(agentFault(loadError));
        setReady(true);
      }
    });
    return () => { active = false; };
  }, [enabled, vaultId]);

  useEffect(() => {
    if (!enabled || vaultId === null || selectedId === null || details[selectedId] !== undefined) return;
    let active = true;
    void getAgentSession(vaultId, selectedId).then(fresh => {
      if (active) setDetails(current => ({ ...current, [selectedId]: fresh }));
    }).catch((loadError: unknown) => {
      if (active) setError(agentFault(loadError));
    });
    return () => { active = false; };
  }, [details, enabled, selectedId, vaultId]);

  useEffect(() => {
    if (vaultId !== null) saveAgentPreferences(vaultId, { open, followAgent, width, sessionId: selectedId, drafts, contextLimitTokens, search });
  }, [contextLimitTokens, drafts, followAgent, open, search, selectedId, vaultId, width]);

  const acceptTurn = useCallback(async (sessionId: string, turn: AgentTurn): Promise<void> => {
    setDetails(current => {
      const detail = current[sessionId];
      if (!detail) return current;
      return { ...current, [sessionId]: { ...detail, turns: detail.turns.map(item => item.id === turn.id ? turn : item) } };
    });
    const submitted = submittedRef.current;
    const isCurrent = (): boolean => submittedRef.current?.id === turn.id
      && followRef.current.active && followRef.current.sessionId === sessionId;
    const events = turn.progress?.events ?? [];
    const latest = events.findLast(event => event.target !== undefined)?.target;
    const location = latest && JSON.stringify(latest);
    const nextLocation = latest && !latest.pendingPublish && turn.id === submitted?.id
      && submitted.seenLocation !== location ? latest : undefined;
    if (submitted?.id === turn.id) submitted.seenLocation = location;
    if (turn.status === 'running') {
      if (nextLocation && isCurrent()) await workspaceRef.current.followAgentLocation(nextLocation, isCurrent);
      return;
    }
    const key = `${sessionId}:${turn.id}`;
    if (finalizedRef.current.has(key)) return;
    finalizedRef.current.add(key);
    try {
      await workspaceRef.current.finishAgentTurn(turn.status === 'done' ? turn.changed : []);
      if (turn.status === 'done' && isCurrent()) {
        const staged = events.findLast(event => event.kind === 'stage'
          && event.target && turn.changed.includes(event.target.path))?.target;
        const changed = turn.changed[0];
        const destination = staged ?? (changed === undefined ? nextLocation : { path: changed });
        if (destination) await workspaceRef.current.followAgentLocation(destination, isCurrent);
      }
    } catch (finishError) {
      setError(agentFault(finishError));
    } finally {
      if (submittedRef.current?.id === turn.id) submittedRef.current = null;
    }
    await refreshSessions();
  }, [refreshSessions]);
  useAgentTurnPolling({ vaultId: vaultId ?? '', details, onTurn: acceptTurn, onError: showError, fault: agentFault });

  const createSession = useCallback(async (): Promise<void> => {
    if (vaultId === null || creating) return;
    setCreating(true);
    setError(null);
    try {
      const session = await createAgentSession(vaultId, crypto.randomUUID());
      setSessions(current => [session, ...current.filter(item => item.id !== session.id)]);
      setDetails(current => ({ ...current, [session.id]: { session, turns: [] } }));
      setSelectedId(session.id);
    } catch (createError) { setError(agentFault(createError)); }
    finally { setCreating(false); }
  }, [creating, vaultId]);

  const submit = useCallback(async (): Promise<void> => {
    if (vaultId === null || selectedId === null || submitting) return;
    const text = (drafts[selectedId] ?? '').trim();
    if (text === '') return;
    const sessionId = selectedId;
    setSubmitting(true);
    setError(null);
    let captured = false;
    try {
      const focus = await workspaceRef.current.captureAgentFocus();
      captured = true;
      const submit: AgentSubmit = { id: crypto.randomUUID(), text, search, focus, contextLimitTokens };
      submittedRef.current = { id: submit.id, seenLocation: undefined };
      const turn = await submitAgentTurn(vaultId, sessionId, submit);
      setDetails(current => {
        const detail = current[sessionId];
        return detail ? { ...current, [sessionId]: { ...detail, turns: [...detail.turns, turn] } } : current;
      });
      setDrafts(current => ({ ...current, [sessionId]: '' }));
      if (turn.status !== 'running') await acceptTurn(sessionId, turn);
    } catch (submitError) {
      submittedRef.current = null;
      setError(agentFault(submitError));
      if (captured) {
        try { await workspaceRef.current.finishAgentTurn([]); }
        catch (finishError) { setError(agentFault(finishError)); }
      }
    } finally { setSubmitting(false); }
  }, [acceptTurn, contextLimitTokens, drafts, search, selectedId, submitting, vaultId]);

  const running = Object.values(details).some(detail => detail.turns.some(turn => turn.status === 'running'));
  return {
    open, setOpen, followAgent, setFollowAgent, width, setWidth, sessions, selectedId, setSelectedId,
    details: selectedId === null ? undefined : details[selectedId], error, ready, submitting, creating, running,
    draft: selectedId === null ? '' : drafts[selectedId] ?? '',
    setDraft: (value: string) => { if (selectedId !== null) setDrafts(current => ({ ...current, [selectedId]: value })); },
    search, setSearch, contextLimitTokens, setContextLimitTokens, submit, createSession,
    clearError: () => setError(null)
  };
}

export type AgentChat = ReturnType<typeof useAgentChat>;
