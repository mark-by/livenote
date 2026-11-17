import type { Block } from '../../shared/types';
import type { DiagramPreviewProps, DiagramValue } from './types';

/** Идентификатор нужен viewer для SVG; координатами документа владеет оболочка. */
export function snapshotBlock(value: DiagramValue, id: string, persisted?: DiagramPreviewProps['persisted']): Block {
  return {
    id: persisted?.blockId ?? id, pageId: persisted?.pageId ?? '',
    type: value.format, source: value.source, title: value.title ?? null,
    position: 0, createdAt: '', updatedAt: '', renderedRevision: null, renderOk: null, renderError: null
  };
}
