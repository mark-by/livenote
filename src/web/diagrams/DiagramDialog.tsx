import { useId } from 'react';
import { createPortal } from 'react-dom';
import { DiagramFullscreen } from '../components/DiagramFullscreen';
import { DrawioFullscreen } from '../components/DrawioFullscreen';
import { EMPTY_DRAWIO_XML } from '../components/DrawioBlockView';
import { BpmnDiagramDialog } from './BpmnDiagramDialog';
import { snapshotBlock } from './snapshotBlock';
import type { DiagramDialogProps } from './types';

const STARTERS = {
  mermaid: 'flowchart LR\n  Start["Начало"]',
  drawio: EMPTY_DRAWIO_XML,
  bpmn: ''
} as const;

export function DiagramDialog(props: DiagramDialogProps): React.JSX.Element {
  return <DiagramDialogSession key={props.session.key} {...props} />;
}

function DiagramDialogSession({ session, onSave, onCancel, persisted }: DiagramDialogProps): React.JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const value = session.mode === 'create' && session.value.source.trim() === ''
    ? { ...session.value, source: STARTERS[session.value.format] }
    : session.value;
  const block = { ...snapshotBlock(value, `dialog-${id}`, persisted), title: null };
  const common = {
    block, pageTitle: value.title ?? 'Схема', pageRevision: persisted?.revision ?? 0,
    persisted: persisted !== undefined, initialEditing: session.mode !== 'view',
    onClose: onCancel,
    onCommit: async (source: string) => { await onSave({ ...value, source }); }
  };
  switch (session.value.format) {
    case 'mermaid': return createPortal(<DiagramFullscreen {...common} />, document.body);
    case 'drawio': return createPortal(<DrawioFullscreen {...common} />, document.body);
    case 'bpmn': return <BpmnDiagramDialog session={session} onSave={onSave} onCancel={onCancel} persisted={persisted} />;
    default: return assertNever(session.value.format);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Неизвестный формат диаграммы: ${String(value)}`);
}
