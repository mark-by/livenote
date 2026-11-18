import { layoutProcess } from 'bpmn-auto-layout';
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import { BpmnModdle } from 'bpmn-moddle';
import type { BpmnModdleRootElement } from 'bpmn-moddle';
import type Canvas from 'diagram-js/lib/core/Canvas';
import type { DiagramValidation } from '../../shared/types';
import { lintBpmn } from './bpmn-lint';
import { invalid } from './protocol';
import type { LayoutOutcome, RenderOutcome } from './protocol';

const moddle = new BpmnModdle();

export async function validateBpmn(source: string): Promise<DiagramValidation> {
  let root: BpmnModdleRootElement;
  try {
    ({ rootElement: root } = await moddle.fromXML(source));
  } catch (error) {
    return invalid(error);
  }
  const lint = await lintBpmn(root);
  return {
    syntax: 'ok',
    renderer: 'playwright',
    diagramType: 'bpmn',
    hasDiagram: (root.diagrams?.length ?? 0) > 0,
    ...(lint.length === 0 ? {} : { lint })
  };
}

export async function renderBpmn(source: string): Promise<RenderOutcome> {
  const validation = await validateBpmn(source);
  if (validation.syntax !== 'ok') return { validation };

  const canvas = document.createElement('div');
  canvas.style.cssText = 'width:100vw;height:100vh';
  document.body.append(canvas);
  const viewer = new NavigatedViewer({ container: canvas });
  try {
    await viewer.importXML(source);
    viewer.get<Canvas>('canvas').zoom('fit-viewport');
    const container = canvas.querySelector<HTMLElement>('.djs-container');
    if (container === null) throw new DOMException('bpmn-js не создал контейнер .djs-container');
    return {
      validation,
      render: { svg: container.outerHTML, width: container.offsetWidth, height: container.offsetHeight }
    };
  } catch (error) {
    return { validation: invalid(error) };
  } finally {
    viewer.destroy();
    canvas.remove();
  }
}

export async function layoutBpmn(source: string): Promise<LayoutOutcome> {
  try {
    const { xml } = await layoutProcess(source);
    return { ok: true, xml };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
