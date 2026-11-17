import { useId } from 'react';
import { Pencil, TrashBin } from '@gravity-ui/icons';
import { MermaidBlockView } from '../components/MermaidBlockView';
import { BpmnBlockView } from '../components/BpmnBlockView';
import { DrawioBlockView } from '../components/DrawioBlockView';
import { DiagramAction } from './DiagramAction';
import { snapshotBlock } from './snapshotBlock';
import type { DiagramPreviewProps } from './types';
import './diagrams.css';

export function DiagramPreview({ value, persisted, onExpand, onEdit, onRemove }: DiagramPreviewProps): React.JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const block = snapshotBlock(value, `preview-${id}`, persisted);
  const props = { block, pageRevision: persisted?.revision ?? 0, persisted: persisted !== undefined, onExpand };
  let preview: React.JSX.Element;
  switch (value.format) {
    case 'mermaid': preview = <MermaidBlockView {...props} />; break;
    case 'bpmn': preview = <BpmnBlockView {...props} />; break;
    case 'drawio': preview = <DrawioBlockView {...props} pageTitle={value.title ?? 'Схема'} />; break;
    default: return assertNever(value.format);
  }
  return <section className="diagram-adapter" aria-label={value.title ?? `Схема ${value.format}`}>
    {preview}
    <div className="diagram-adapter__edit">
      <DiagramAction label="Редактировать диаграмму" icon={Pencil} onPress={onEdit} />
      {onRemove && <DiagramAction label="Удалить диаграмму" icon={TrashBin} onPress={onRemove} />}
    </div>
  </section>;
}

function assertNever(value: never): never {
  throw new TypeError(`Неизвестный формат диаграммы: ${String(value)}`);
}
