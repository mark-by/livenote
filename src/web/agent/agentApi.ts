import type {
  AgentBindingRequest, AgentBindingView, AgentConnection, AgentProfile, AgentSecretChange,
  AgentSessionSummary, AgentSubmit, AgentTurn
} from '../../shared/types';
import { agentApiBase } from '../../shared/types';
import { requestAgent } from '../api';
import {
  agentBindingSchema, agentConnectionSchema, agentConnectionsSchema,
  agentEmptySchema, agentLocalDirSchema, agentSessionDetailsSchema, agentSessionSchema,
  agentSessionsSchema, agentTurnSchema
} from './agentSchemas';

const segment = (value: string): string => encodeURIComponent(value);
const sessionPath = (vaultId: string, sessionId: string): string => `${agentApiBase(vaultId)}/sessions/${segment(sessionId)}`;

export function listAgentSessions(vaultId: string): Promise<AgentSessionSummary[]> {
  return requestAgent(`${agentApiBase(vaultId)}/sessions`, { schema: agentSessionsSchema });
}

export function createAgentSession(vaultId: string, id: string): Promise<AgentSessionSummary> {
  return requestAgent(`${agentApiBase(vaultId)}/sessions`, { method: 'POST', body: { id }, schema: agentSessionSchema });
}

export function getAgentSession(vaultId: string, sessionId: string): Promise<{ session: AgentSessionSummary; turns: AgentTurn[] }> {
  return requestAgent(sessionPath(vaultId, sessionId), { schema: agentSessionDetailsSchema });
}

export function submitAgentTurn(vaultId: string, sessionId: string, submit: AgentSubmit): Promise<AgentTurn> {
  return requestAgent(`${sessionPath(vaultId, sessionId)}/turns`, { method: 'POST', body: submit, schema: agentTurnSchema });
}

export function getAgentTurn(vaultId: string, sessionId: string, turnId: string): Promise<AgentTurn> {
  return requestAgent(`${sessionPath(vaultId, sessionId)}/turns/${segment(turnId)}`, { schema: agentTurnSchema });
}

export function getAgentBinding(vaultId: string, folder: string): Promise<AgentBindingView> {
  const query = new URLSearchParams({ folder });
  return requestAgent(`${agentApiBase(vaultId)}/binding?${query}`, { schema: agentBindingSchema });
}

export function putAgentBinding(vaultId: string, binding: AgentBindingRequest): Promise<AgentBindingView> {
  return requestAgent(`${agentApiBase(vaultId)}/binding`, { method: 'PUT', body: binding, schema: agentBindingSchema });
}

export function pickAgentBindingFolder(vaultId: string): Promise<{ localDir: string | null }> {
  return requestAgent(`${agentApiBase(vaultId)}/binding/pick`, { method: 'POST', body: {}, schema: agentLocalDirSchema });
}

export function listAgentConnections(vaultId: string): Promise<AgentConnection[]> {
  return requestAgent(`${agentApiBase(vaultId)}/connections`, { schema: agentConnectionsSchema });
}

export function putAgentConnection(vaultId: string, profile: AgentProfile, secret: AgentSecretChange): Promise<AgentConnection> {
  return requestAgent(`${agentApiBase(vaultId)}/connections/${profile.kind}`, {
    method: 'PUT', body: { profile, secret }, schema: agentConnectionSchema
  });
}

export function beginAgentOauth(vaultId: string, slot: Exclude<AgentProfile['kind'], 'model'>): Promise<Record<string, never>> {
  return requestAgent(`${agentApiBase(vaultId)}/connections/${slot}/oauth`, { method: 'POST', body: {}, schema: agentEmptySchema });
}
