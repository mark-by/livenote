import { layoutBpmn, renderBpmn, validateBpmn } from './bpmn';
import { renderDrawio } from './drawio';
import { validateDrawio } from './drawio-xml';
import { renderMermaid, validateMermaid } from './mermaid';
import { request } from './protocol';

const preview = document.createElement('div');
document.body.append(preview);

async function run(input: unknown) {
  const job = request.parse(input);
  preview.replaceChildren();
  switch (job.operation) {
    case 'validate': {
      const validators = {
        bpmn: validateBpmn,
        drawio: validateDrawio,
        mermaid: validateMermaid
      };
      return validators[job.format](job.source, job.theme);
    }
    case 'render': {
      const renderers = {
        bpmn: renderBpmn,
        drawio: renderDrawio,
        mermaid: renderMermaid
      };
      const outcome = await renderers[job.format](job.source, job.theme);
      if (!job.includePng || outcome.render === undefined) return { outcome };

      const template = document.createElement('template');
      template.innerHTML = outcome.render.svg;
      const drawing = template.content.querySelector(job.format === 'bpmn' ? '.djs-container' : 'svg');
      if (drawing === null) return { outcome };
      preview.append(drawing);
      if (drawing instanceof HTMLElement) {
        drawing.style.width = `${outcome.render.width ?? 1024}px`;
        drawing.style.height = `${outcome.render.height ?? 768}px`;
      }
      const { x, y, width, height } = drawing.getBoundingClientRect();
      return { outcome, clip: { x, y, width, height, scale: 1 } };
    }
    case 'layout_bpmn':
      return layoutBpmn(job.source);
    default: {
      const exhaustive: never = job;
      return exhaustive;
    }
  }
}

Object.assign(globalThis, { livenoteDiagramWorker: run });
