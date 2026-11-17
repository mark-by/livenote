import { z } from 'zod';
import { InvalidRequestError } from './errors.js';

const version = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const assetSchema = z.object({ path: z.string(), source: z.string(), expectedVersion: version.nullable(), layout: z.enum(['preserve', 'auto']).optional() });
export const referenceSchema = z.object({ path: z.string(), expectedVersion: version });
export const documentSchema = z.object({
  expectedRevision: z.number().int().positive(), expectedVersion: version, source: z.string(),
  assets: z.array(assetSchema).optional(), references: z.array(referenceSchema).optional(), requestId: z.string().optional()
});
export const createSchema = z.object({
  title: z.string(), path: z.string().optional(), source: z.string().optional(), format: z.enum(['mermaid', 'bpmn', 'drawio']).optional(),
  requestId: z.string().optional(), aliases: z.array(z.string()).optional(), tags: z.array(z.string()).optional()
});
export const folderSchema = z.object({ path: z.string(), expectedTreeVersion: version });
export const moveFolderSchema = folderSchema.extend({ from: z.string() });
export const deleteFolderSchema = folderSchema.extend({ recursive: z.boolean().optional() });
export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvalidRequestError('Некорректное тело запроса', { issues: parsed.error.issues });
  return parsed.data;
}
