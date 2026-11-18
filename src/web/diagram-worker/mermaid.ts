import mermaid from 'mermaid';
import { z } from 'zod';
import type { DiagramValidation, MermaidTheme } from '../../shared/types';
import { invalid } from './protocol';
import type { RenderOutcome } from './protocol';

const errorLocation = z.object({
  hash: z.object({ loc: z.object({ start_line: z.number().int().nonnegative() }) })
});

export async function validateMermaid(source: string, theme: MermaidTheme): Promise<DiagramValidation> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme,
    elk: { straightenEdges: false }
  });
  try {
    const parsed = await mermaid.parse(source, { suppressErrors: false });
    return {
      syntax: 'ok',
      renderer: 'playwright',
      diagramType: parsed.diagramType
    };
  } catch (error) {
    const parsed = errorLocation.safeParse(error);
    return invalid(error, parsed.success ? parsed.data.hash.loc.start_line : undefined);
  }
}

export async function renderMermaid(source: string, theme: MermaidTheme): Promise<RenderOutcome> {
  const validation = await validateMermaid(source, theme);
  if (validation.syntax !== 'ok') return { validation };

  const { svg } = await mermaid.render(`livenote-${crypto.randomUUID()}`, source);
  const template = document.createElement('template');
  template.innerHTML = svg;
  const element = template.content.querySelector('svg');
  const [, , boxWidth, boxHeight] = element?.getAttribute('viewBox')?.trim().split(/[\s,]+/) ?? [];
  const width = Number(/^\s*([\d.]+)\s*(?:px|pt)?\s*$/i.exec(element?.getAttribute('width') ?? '')?.[1])
    || Number(boxWidth) || undefined;
  const height = Number(/^\s*([\d.]+)\s*(?:px|pt)?\s*$/i.exec(element?.getAttribute('height') ?? '')?.[1])
    || Number(boxHeight) || undefined;
  return {
    validation,
    render: {
      svg,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height })
    }
  };
}
