import { useRef, useState } from 'react';
import { Button, Modal } from '@heroui/react';
import { ArrowUturnCcwLeft, ArrowUturnCwRight, ArrowsExpand, Copy } from '@gravity-ui/icons';
import { downloadDiagramSvg, downloadTextFile } from '../svgDownload';
import { useConfirm } from '../components/ConfirmDialog';
import { BpmnBlockView } from '../components/BpmnBlockView';
import { DiagramAction } from './DiagramAction';
import { notifyDiagramDownload } from './diagramDownload';
import { useBpmnModeler } from './useBpmnModeler';
import { snapshotBlock } from './snapshotBlock';
import type { DiagramDialogProps } from './types';
import type { WriteLayout } from '../../shared/types';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';
import './diagrams.css';

/** Modeler владеет графическим черновиком; только onSave публикует XML. */
export function BpmnDiagramDialog({ session, onSave, onCancel }: DiagramDialogProps): React.JSX.Element {
  const [editing, setEditing] = useState(session.mode !== 'view');
  const editor = useBpmnModeler(session, editing);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { confirm, dialog } = useConfirm();
  const filename = session.value.title ?? 'Схема';

  const cancel = async (): Promise<void> => {
    if (savingRef.current || dialog !== null) return;
    if (editor.dirty && !await confirm({
      title: 'Отменить изменения?', message: 'Изменения BPMN ещё не сохранены.',
      confirmLabel: 'Отменить изменения', danger: true
    })) return;
    onCancel();
  };

  const save = async (layout: WriteLayout = 'preserve'): Promise<void> => {
    if (savingRef.current || (!editor.ready && (layout === 'preserve' || session.value.source === ''))) return;
    savingRef.current = true;
    setSaving(true);
    editor.setError(null);
    try {
      const source = editor.ready ? await editor.xml() : session.value.source;
      await onSave({ ...session.value, source }, { layout });
    } catch (failure) {
      editor.setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const exportDiagram = async (format: 'xml' | 'svg' | 'copy'): Promise<void> => {
    editor.setError(null);
    if (format === 'copy') {
      try {
        await navigator.clipboard.writeText(await editor.xml());
      } catch (failure) {
        editor.setError(failure instanceof Error ? failure.message : String(failure));
      }
      return;
    }
    const downloadName = `${filename}.${format === 'xml' ? 'bpmn' : 'svg'}`;
    await notifyDiagramDownload(downloadName, async () => {
      const xml = await editor.xml();
      if (format === 'xml') {
        downloadTextFile(xml, downloadName, 'application/xml');
        return;
      }
      const modeler = editor.modelerRef.current;
      if (!modeler) throw new Error('Редактор BPMN не готов');
      const { svg } = await modeler.saveSVG();
      return downloadDiagramSvg(svg, downloadName);
    });
  };

  return <>
    <Modal.Backdrop isOpen isDismissable={false} isKeyboardDismissDisabled={saving || dialog !== null}
      onOpenChange={(open) => { if (!open) void cancel(); }}>
      <Modal.Container size="full" className="bpmn-editor-container">
        <Modal.Dialog className="bpmn-editor-dialog" aria-label={`${filename} — схема BPMN`}>
          <div className="bpmn-editor-surface" onKeyDown={(event) => {
            // diagram-js обрабатывает canvas первым; Markdown/Vim снаружи не получает клавиши.
            event.stopPropagation();
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              if (editing) void save();
            }
          }}>
          <Modal.Header className="bpmn-editor-header">
            <Modal.Heading>{filename}</Modal.Heading>
            <div className="bpmn-editor-actions">
              {editing ? <>
              <DiagramAction label="Отменить действие" icon={ArrowUturnCcwLeft} disabled={saving || !editor.history.undo} onPress={editor.undo} />
              <DiagramAction label="Повторить действие" icon={ArrowUturnCwRight} disabled={saving || !editor.history.redo} onPress={editor.redo} />
              <DiagramAction label="Сбросить масштаб" icon={ArrowsExpand} disabled={!editor.ready} onPress={editor.fit} />
              <DiagramAction label="Копировать исходник" icon={Copy} disabled={!editor.ready || saving} onPress={() => { void exportDiagram('copy'); }} />
              <Button variant="ghost" isDisabled={!editor.ready || saving} onPress={() => { void exportDiagram('xml'); }}
                aria-label="Скачать BPMN XML">XML</Button>
              <Button variant="ghost" isDisabled={!editor.ready || saving} onPress={() => { void exportDiagram('svg'); }}
                aria-label="Скачать SVG">SVG</Button>
              <Button variant="ghost" isDisabled={saving} onPress={() => { void cancel(); }}>Отмена</Button>
              <Button variant="primary" isDisabled={!editor.ready || saving} onPress={() => { void save(); }}>
                {saving ? 'Сохранение…' : 'Сохранить'}
              </Button>
              </> : <>
                <Button variant="ghost" onPress={onCancel}>Закрыть</Button>
                <Button variant="primary" onPress={() => setEditing(true)}>Редактировать</Button>
              </>}
            </div>
          </Modal.Header>
          {editor.error && <div className="bpmn-editor-error" role="alert">{editor.error}</div>}
          {editor.error && !editor.ready && <Button variant="secondary" isDisabled={saving || session.value.source === ''}
            onPress={() => { void save('auto'); }}>Сохранить с автораскладкой</Button>}
          {editing ? <>
            {!editor.ready && !editor.error && <div role="status">Загрузка редактора BPMN…</div>}
            <div ref={editor.hostRef} className="bpmn-editor-canvas" aria-label="Графический редактор BPMN"
              aria-busy={!editor.ready || saving} inert={saving} />
          </> : <div className="bpmn-editor-view">
            <BpmnBlockView block={snapshotBlock(session.value, 'bpmn-fullscreen')} pageRevision={0} persisted={false} />
          </div>}
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
    {dialog}
  </>;
}
