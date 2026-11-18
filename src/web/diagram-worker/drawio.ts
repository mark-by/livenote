import { z } from 'zod';
import { validateDrawio } from './drawio-xml';
import type { RenderOutcome } from './protocol';

const response = z.discriminatedUnion('event', [
  z.object({ event: z.literal('init') }),
  z.object({
    event: z.literal('export'),
    message: z.object({ requestId: z.string() }),
    data: z.string().optional()
  })
]);

class DrawioExportError extends Error {}

export async function renderDrawio(source: string): Promise<RenderOutcome> {
  const validation = await validateDrawio(source);
  if (validation.syntax !== 'ok') return { validation };

  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = '/drawio/index.html?embed=1&proto=json&offline=1&noSaveBtn=1&noExitBtn=1&saveAndExit=0&contrast=0';
  const listener = new AbortController();
  const requestId = crypto.randomUUID();
  try {
    const svg = await new Promise<string>((resolve, reject) => {
      window.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || typeof event.data !== 'string') return;
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch (error) {
          if (error instanceof SyntaxError) return;
          throw error;
        }
        const parsed = response.safeParse(payload);
        if (!parsed.success) return;
        const message = parsed.data;
        switch (message.event) {
          case 'init':
            frame.contentWindow?.postMessage(JSON.stringify({
              action: 'export', format: 'svg', theme: 'light', asText: true,
              embedImages: false, embedFonts: false, xml: source, requestId
            }), location.origin);
            return;
          case 'export':
            if (message.message.requestId !== requestId) return;
            if (message.data?.includes('<svg')) resolve(message.data);
            else reject(new DrawioExportError('draw.io не вернул SVG'));
            return;
          default: {
            const exhaustive: never = message;
            return exhaustive;
          }
        }
      }, { signal: listener.signal });
      document.body.append(frame);
    });
    return { validation, render: { svg } };
  } finally {
    listener.abort();
    frame.remove();
  }
}
