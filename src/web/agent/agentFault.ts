import type { AgentFault } from '../../shared/types';
import { ApiError } from '../api';
import { agentFaultSchema } from './agentSchemas';

export function agentFault(error: unknown): AgentFault {
  if (error instanceof ApiError) {
    const parsed = agentFaultSchema.safeParse({ code: error.code, message: error.message, details: error.details });
    if (parsed.success) return parsed.data;
    return { code: error.code, message: error.message };
  }
  return { code: 'client', message: error instanceof Error ? error.message : String(error) };
}
