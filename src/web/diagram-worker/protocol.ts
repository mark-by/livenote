import { z } from 'zod';
import { MERMAID_THEMES } from '../../shared/types';
import type { DiagramRenderResult, DiagramValidation } from '../../shared/types';

const diagram = {
  format: z.enum(['mermaid', 'bpmn', 'drawio']),
  source: z.string(),
  theme: z.enum(MERMAID_THEMES)
};

export const request = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('validate'), ...diagram }),
  z.object({ operation: z.literal('render'), ...diagram, includePng: z.boolean() }),
  z.object({ operation: z.literal('layout_bpmn'), source: z.string() })
]);

export type RenderOutcome = {
  readonly validation: DiagramValidation;
  readonly render?: DiagramRenderResult;
};

export type LayoutOutcome =
  | { readonly ok: true; readonly xml: string }
  | { readonly ok: false; readonly error: string };

export function invalid(error: unknown, line?: number): DiagramValidation {
  return {
    syntax: 'error',
    renderer: 'playwright',
    error: {
      message: error instanceof Error ? error.message : String(error),
      ...(line === undefined ? {} : { line })
    }
  };
}
