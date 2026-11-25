import { z } from 'zod';
import type {
  AgentBindingView, AgentConnection, AgentFault, AgentProgressEvent, AgentSessionSummary, AgentTurn,
  AgentTurnProgress
} from '../../shared/types';

const pathSchema = z.string();
const faultSchema: z.ZodType<AgentFault> = z.object({
  code: z.string(), message: z.string(),
  details: z.object({ paths: z.array(pathSchema).optional() }).optional()
});
const citeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['vault', 'localCode']), path: pathSchema, line: z.number() }),
  z.object({ kind: z.literal('remoteCode'), url: z.string(), path: pathSchema, line: z.number() }),
  z.object({ kind: z.literal('confluence'), url: z.string(), title: z.string() })
]);
const progressEventSchema: z.ZodType<AgentProgressEvent> = z.object({
  kind: z.enum(['plan', 'model', 'verify', 'search', 'next_source', 'read_vault', 'read_source', 'check', 'stage', 'commit']),
  source: z.enum(['vault', 'localCode', 'remoteCode', 'confluence']).optional(),
  target: z.object({
    path: pathSchema, line: z.number().int().positive().optional(), pendingPublish: z.boolean().optional()
  }).optional()
});
const progressSchema: z.ZodType<AgentTurnProgress> = z.object({
  stepsUsed: z.number(), contextTokens: z.number(), contextLimitTokens: z.number(),
  events: z.array(progressEventSchema)
});
const turnBase = { id: z.string(), text: z.string(), at: z.string(), progress: progressSchema.optional() };
export const agentTurnSchema: z.ZodType<AgentTurn> = z.discriminatedUnion('status', [
  z.object({ ...turnBase, status: z.literal('running') }),
  z.object({ ...turnBase, status: z.literal('done'), answer: z.string(), cites: z.array(citeSchema), changed: z.array(pathSchema) }),
  z.object({ ...turnBase, status: z.literal('failed'), error: faultSchema }),
  z.object({ ...turnBase, status: z.literal('interrupted'), error: faultSchema })
]);
const sessionSchema: z.ZodType<AgentSessionSummary> = z.object({ id: z.string(), title: z.string(), updatedAt: z.string() });
export const agentSessionsSchema = z.array(sessionSchema);
export const agentSessionSchema = sessionSchema;
export const agentSessionDetailsSchema = z.object({ session: sessionSchema, turns: z.array(agentTurnSchema) });
const repoSchema = z.object({ provider: z.enum(['gitlab', 'github']), url: z.string(), ref: z.string().optional() });
export const agentBindingSchema: z.ZodType<AgentBindingView> = z.object({
  value: z.object({ repo: repoSchema.nullable(), localDir: z.string().nullable() }),
  version: z.string().nullable()
});
export const agentLocalDirSchema = z.object({ localDir: z.string().nullable() });
const profileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), baseUrl: z.string(), model: z.string() }),
  z.object({ kind: z.enum(['confluence', 'gitlab', 'github']), endpoint: z.string(), resourceHost: z.string() })
]);
export const agentConnectionSchema: z.ZodType<AgentConnection> = z.object({
  profile: profileSchema, state: z.enum(['missing', 'ready', 'expired', 'unsupported'])
});
export const agentConnectionsSchema = z.array(agentConnectionSchema);
export const agentEmptySchema = z.object({});
export { faultSchema as agentFaultSchema };
