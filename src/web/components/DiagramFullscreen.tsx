import { useRef, useState } from 'react';
import { Button } from '@heroui/react';
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
import { useFullscreenFocus } from '../diagrams/useFullscreenFocus';
import type { DiagramCommit } from '../diagrams/types';
import { MermaidSourcePanel } from '../diagrams/MermaidSourcePanel';

interface DiagramFullscreenProps {
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
  block, pageTitle, pageRevision, onSaved, onClose, onCommit, initialEditing, persisted = true
}: DiagramFullscreenProps): React.JSX.Element {
  const editor = useDiagramEditor({ block, pageRevision, onSaved, onClose, onCommit, initialEditing });
  const [sourceEditing, setSourceEditing] = useState(initialEditing === true && editor.model === null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const view = useMermaidViewport({ blockId: block.id, editor, editorRef });
  const previewReady = view.renderedSource === editor.source && view.error === null;
  const save = (): void => {
    if (editor.editing && previewReady && editor.valid) void editor.save();
  };
  const focus = useFullscreenFocus({
    close: () => { void editor.close(); }, suspended: editor.dialog !== null, saving: editor.saving,
    save
  });

  return (
    <div className="diagram-fullscreen" role="dialog" aria-modal="true"
      aria-label={`${pageTitle} — схема Mermaid`} onKeyDown={focus.onKeyDown}>
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
          {editor.editing ? <>
            <Button variant="primary" className="diagram-fullscreen__btn diagram-fullscreen__btn--primary"
              isDisabled={(!editor.dirty && !onCommit) || editor.saving || !editor.valid || !previewReady}
              onPress={save}>{editor.saving ? 'Сохранение…' : 'Сохранить'}</Button>
            <Button variant="ghost" className="diagram-fullscreen__btn" isDisabled={editor.saving}
              onPress={() => { void editor.cancel(); }}>Отмена</Button>
          </> : <Button variant="secondary" className="diagram-fullscreen__btn" onPress={() => {
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
          <Button ref={focus.closeRef} variant="ghost" className="diagram-fullscreen__btn diagram-fullscreen__btn--close"
            onPress={() => { void editor.close(); }} isDisabled={editor.saving} aria-label="Закрыть">Закрыть</Button>
        </div>
      </div>
      <div className="diagram-fullscreen__workspace">
        <div className="diagram-fullscreen__body">
          <div className={`diagram-fullscreen__canvas${editor.editing ? ' diagram-fullscreen__canvas--editing' : ''}`} ref={view.canvasRef}>
            <div className="diagram-fullscreen__svg" ref={view.hostRef} onClick={editor.selectFromDiagram} />
          </div>
        </div>
        {editor.editing && (sourceEditing
          ? <MermaidSourcePanel editor={editor} />
          : <DiagramEditorPanel editor={editor} />)}
      </div>
      {editor.dialog}
    </div>
  );
}
