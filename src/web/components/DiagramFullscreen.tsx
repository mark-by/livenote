import { useImperativeHandle, useRef, useState } from 'react';
import { Button, Modal } from '@heroui/react';
import { ArrowDownToLine, MagnifierPlus, MagnifierMinus, ArrowsExpand } from '@gravity-ui/icons';
import type { Block } from '../../shared/types';
import { updateBlock } from '../api';
import { diagramFilename } from '../svgDownload';
import { downloadMermaid } from '../diagrams/mermaidDownload';
import { DiagramEditorPanel } from './DiagramEditorPanel';
import { CopyButton } from './CopyButton';
import { useDiagramEditor } from './useDiagramEditor';
import { DiagramAction } from '../diagrams/DiagramAction';
import { BpmnDiagramDialog } from '../diagrams/BpmnDiagramDialog';
import { useMermaidViewport } from '../diagrams/useMermaidViewport';
import { agentDialogLayout } from '../diagrams/types';
import type { DiagramAgentProps, DiagramCommit } from '../diagrams/types';
import { MermaidSourcePanel } from '../diagrams/MermaidSourcePanel';

interface DiagramFullscreenProps extends DiagramAgentProps {
  readonly block: Block;
  readonly pageTitle: string;
  readonly pageRevision: number;
  readonly onSaved?: (source: string, revision: number) => void;
  readonly onClose: () => void;
  readonly onCommit?: DiagramCommit;
  readonly initialEditing?: boolean;
  readonly persisted?: boolean;
}

export function DiagramFullscreen(props: DiagramFullscreenProps): React.JSX.Element {
  if (props.block.type === 'bpmn') {
    return <BpmnDiagramDialog
      session={{ key: props.block.id, mode: props.initialEditing ? 'edit' : 'view',
        value: { format: 'bpmn', source: props.block.source, title: props.block.title ?? props.pageTitle } }}
      agentPanel={props.agentPanel} agentEditorRef={props.agentEditorRef} agentLocked={props.agentLocked}
      onCancel={props.onClose}
      onSave={async (value, options) => {
        if (props.onCommit) {
          await props.onCommit(value.source, options);
        } else {
          const result = await updateBlock(props.block.pageId, props.block.id, {
            source: value.source, expectedRevision: props.pageRevision
          });
          if (result.validation?.syntax === 'error') {
            throw new TypeError(result.validation.error?.message ?? 'Сервер отклонил BPMN.');
          }
          props.onSaved?.(value.source, result.revision);
        }
      }} />;
  }
  return <MermaidFullscreen {...props} />;
}

function MermaidFullscreen({
  block, pageTitle, pageRevision, onSaved, onClose, onCommit, initialEditing, persisted = true,
  agentPanel, agentEditorRef, agentLocked = false
}: DiagramFullscreenProps): React.JSX.Element {
  const editor = useDiagramEditor({ block, pageRevision, onSaved, onClose, onCommit, initialEditing, agentLocked, agentContext: !!agentEditorRef });
  useImperativeHandle(agentEditorRef, () => ({
    capture() {
      if (editor.saving || editor.dialog) throw new Error('Дождитесь завершения действия в редакторе Mermaid.');
      if (!editor.valid) throw new Error(editor.error ?? 'Исправьте исходник Mermaid перед отправкой.');
      const { selection, source } = editor;
      return { selected: selection ? [{ kind: selection.type, id: selection.id }] : [], source: Promise.resolve(source) };
    }
  }));
  const [sourceEditing, setSourceEditing] = useState(initialEditing === true && editor.model === null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const view = useMermaidViewport({ blockId: block.id, editor, editorRef });
  const previewReady = view.renderedSource === editor.source && view.error === null;
  const save = (): void => {
    if (editor.editing && previewReady && editor.valid) void editor.save();
  };
  return (
    <>
    <Modal.Backdrop isOpen isDismissable={false} isKeyboardDismissDisabled={agentLocked || editor.saving || editor.dialog !== null}
      onOpenChange={(open) => { if (!open) void editor.close(); }}>
      <Modal.Container size="full" className="diagram-fullscreen-container">
        <Modal.Dialog className="diagram-fullscreen" aria-label={`${pageTitle} — схема Mermaid`} style={agentPanel ? agentDialogLayout : undefined}>
          <div className="diagram-fullscreen__content" onKeyDown={(event) => {
            event.stopPropagation();
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              if (!editor.saving) save();
            }
          }}>
      <div className="diagram-fullscreen__panel">
        <div className="diagram-fullscreen__heading">
          <span className="diagram-fullscreen__title">{pageTitle}</span>
          {block.title && <span className="diagram-fullscreen__diagram-title">{block.title}</span>}
          <span className="diagram-fullscreen__type">Mermaid</span>
        </div>
        {view.error && <div className="diagram-fullscreen__error" role="alert">
          Ошибка рендера диаграммы: {view.error}
        </div>}
        <div className="diagram-fullscreen__controls">
          {editor.editing ? <fieldset disabled={agentLocked} style={{ display: 'contents' }}>
            <Button variant="primary" className="diagram-fullscreen__btn diagram-fullscreen__btn--primary"
              isDisabled={(!editor.dirty && !onCommit) || editor.saving || !editor.valid || !previewReady}
              onPress={save}>{editor.saving ? 'Сохранение…' : 'Сохранить'}</Button>
            <Button variant="ghost" className="diagram-fullscreen__btn" isDisabled={editor.saving}
              onPress={() => { void editor.cancel(); }}>Отмена</Button>
          </fieldset> : <Button isDisabled={agentLocked} variant="secondary" className="diagram-fullscreen__btn" onPress={() => {
            setSourceEditing(editor.model === null);
            editor.start();
          }} aria-label="Редактировать">Редактировать</Button>}
          <DiagramAction label="Приблизить" icon={MagnifierPlus} onPress={() => view.zoom(1.2)} className="diagram-fullscreen__btn" />
          <DiagramAction label="Отдалить" icon={MagnifierMinus} onPress={() => view.zoom(1 / 1.2)} className="diagram-fullscreen__btn" />
          <DiagramAction label="Сбросить масштаб" icon={ArrowsExpand} onPress={view.fit} className="diagram-fullscreen__btn" />
          <CopyButton text={editor.source} title="Копировать исходник" className="diagram-fullscreen__btn" />
          <Button variant="primary" className="diagram-fullscreen__btn diagram-fullscreen__btn--primary" aria-label="Скачать SVG"
            isDisabled={!previewReady} onPress={() => {
              if (view.svgRef.current) {
                const filename = diagramFilename(pageTitle, block.id, 'svg');
                void downloadMermaid('svg', filename, block, view.svgRef.current);
              }
            }}><ArrowDownToLine aria-hidden="true" />SVG</Button>
          {persisted && <Button variant="ghost" className="diagram-fullscreen__btn" aria-label="Скачать PNG"
            isDisabled={editor.editing || !previewReady} onPress={() => {
              const filename = diagramFilename(pageTitle, block.id, 'png');
              void downloadMermaid('png', filename, block, '');
            }}><ArrowDownToLine aria-hidden="true" />PNG</Button>}
          <Button variant="ghost" className="diagram-fullscreen__btn" aria-label="Скачать исходник Mermaid"
            onPress={() => {
              const filename = diagramFilename(pageTitle, block.id, 'mmd');
              void downloadMermaid('mmd', filename, block, editor.source);
            }}>Mermaid</Button>
          <Button variant="ghost" className="diagram-fullscreen__btn diagram-fullscreen__btn--close"
            onPress={() => { void editor.close(); }} isDisabled={editor.saving || agentLocked} aria-label="Закрыть">Закрыть</Button>
        </div>
      </div>
      <div className="diagram-fullscreen__workspace">
        <div className="diagram-fullscreen__body">
          <div className={`diagram-fullscreen__canvas${editor.editing ? ' diagram-fullscreen__canvas--editing' : ''}`} ref={view.canvasRef}>
            <div className="diagram-fullscreen__svg" ref={view.hostRef} onClick={editor.selectFromDiagram} />
          </div>
        </div>
        {editor.editing && <div style={{ display: 'contents' }} inert={agentLocked}>{sourceEditing
          ? <MermaidSourcePanel editor={editor} />
          : <DiagramEditorPanel editor={editor} />}</div>}
      </div>
          </div>
          {agentPanel && <div className="min-h-0 overflow-auto">{agentPanel}</div>}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
    {editor.dialog}
    </>
  );
}
