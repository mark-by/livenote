import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { Block } from '../../shared/types';
import { ApiError, downloadBlockPng, updateBlock } from '../api';
import { diagramFilename, downloadDiagramSvg, downloadTextFile } from '../svgDownload';
import { useConfirm } from './ConfirmDialog';
import { useDrawioFrame, DRAWIO_MODAL_EVENT } from './useDrawioFrame';
import type { DiagramCommit } from '../diagrams/types';
import { useFullscreenFocus } from '../diagrams/useFullscreenFocus';
import { DiagramAction } from '../diagrams/DiagramAction';
import { Copy } from '@gravity-ui/icons';

interface DrawioFullscreenProps {
  block: Block;
  pageTitle: string;
  pageRevision: number;
  onSaved?(source: string, revision: number): void;
  onClose(): void;
  onCommit?: DiagramCommit;
  initialEditing?: boolean;
  persisted?: boolean;
}

export function DrawioFullscreen({ block, pageTitle, pageRevision, onSaved, onClose, onCommit, persisted = true }: DrawioFullscreenProps): React.JSX.Element {
  const [draft, setDraft] = useState(block.source);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const dirtyRef = useRef(false);
  const changedRef = useRef(false);
  const savingRef = useRef(saving);
  const dirty = draft !== block.source;
  dirtyRef.current = dirty;
  savingRef.current = saving;

  const { iframeRef, ready, error, exportDiagram } = useDrawioFrame({
    xml: block.source,
    frameKey: block.id,
    onAutosave: (xml) => {
      // autosave меняет только локальный черновик, никаких REST-записей и load.
      setDraft(xml);
      changedRef.current = true;
      setSaveError(null);
    }
  });

  const save = async (): Promise<void> => {
    if (savingRef.current || !ready) return;
    setSaving(true);
    savingRef.current = true;
    setSaveError(null);
    try {
      // resetEditor заставляет draw.io завершить текущее редактирование текста;
      // только следующий свежий export xml является источником для записи.
      const exported = await exportDiagram('xml', true);
      const source = onCommit && !changedRef.current ? block.source : exported;
      if (!source.trim()) throw new Error('draw.io вернул пустой XML');
      if (onCommit) {
        await onCommit(source);
      } else {
        const result = await updateBlock(block.pageId, block.id, {
          source, expectedRevision: pageRevision
        });
        if (result.validation?.syntax === 'error') {
          setSaveError(result.validation.error?.message ?? 'Сервер отклонил XML draw.io.');
          return;
        }
        onSaved?.(source, result.revision);
      }
      setDraft(source);
      changedRef.current = false;
    } catch (saveFailure) {
      // При конфликте iframe и draft остаются нетронутыми.
      setSaveError(saveFailure instanceof ApiError && saveFailure.code === 'conflict'
        ? 'Страница изменилась на сервере. Черновик сохранён в редакторе; закройте схему, обновите страницу и перенесите изменения вручную.'
        : saveFailure instanceof Error ? saveFailure.message : String(saveFailure));
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  const cancel = async (): Promise<void> => {
    if (savingRef.current || dialog !== null) return;
    if (dirtyRef.current) {
      const discard = await confirm({
        title: 'Отменить изменения?',
        message: 'Изменения draw.io ещё не сохранены на странице.',
        confirmLabel: 'Отменить изменения',
        danger: true
      });
      if (!discard) return;
    }
    onClose();
  };
  const focus = useFullscreenFocus({
    close: () => { void cancel(); }, suspended: dialog !== null, saving, save: () => { void save(); }
  });

  const download = async (format: 'drawio' | 'svg' | 'png'): Promise<void> => {
    setSaveError(null);
    try {
      if (format === 'png') {
        await downloadBlockPng(block.pageId, block.id, diagramFilename(pageTitle, block.id, 'png'));
        return;
      }
      const source = await exportDiagram(format === 'drawio' ? 'xml' : 'svg', true);
      if (format === 'drawio') {
        downloadTextFile(source, diagramFilename(pageTitle, block.id, 'drawio'), 'application/xml');
      } else {
        downloadDiagramSvg(source, diagramFilename(pageTitle, block.id, 'svg'));
      }
    } catch (downloadError) {
      setSaveError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    }
  };

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(DRAWIO_MODAL_EVENT, { detail: { open: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent(DRAWIO_MODAL_EVENT, { detail: { open: false } }));
    };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  return (
    <div className="drawio-fullscreen" role="dialog" aria-modal="true" aria-label={`${pageTitle} — схема draw.io`}
      onKeyDown={focus.onKeyDown}>
      <div className="drawio-fullscreen__panel">
        <div className="drawio-fullscreen__heading">
          <span className="drawio-fullscreen__title">{pageTitle}</span>
          {block.title && <span className="drawio-fullscreen__diagram-title">{block.title}</span>}
          <span className="drawio-fullscreen__type">draw.io</span>
          {dirty && <span className="drawio-fullscreen__dirty">Есть несохранённые изменения</span>}
        </div>
        <div className="drawio-fullscreen__controls">
          <Button variant="primary" className="drawio-fullscreen__btn drawio-fullscreen__btn--primary"
            isDisabled={saving || !ready || error !== null} onPress={() => { void save(); }}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
          <Button ref={focus.closeRef} variant="ghost" className="drawio-fullscreen__btn" isDisabled={saving}
            onPress={() => { void cancel(); }}>Отмена</Button>
          <DiagramAction label="Копировать исходник" icon={Copy} className="drawio-fullscreen__btn"
            disabled={!ready || saving} onPress={() => {
              void exportDiagram('xml', true).then((source) => navigator.clipboard.writeText(source))
                .catch((failure: unknown) => setSaveError(failure instanceof Error ? failure.message : String(failure)));
            }} />
          <Button variant="ghost" className="drawio-fullscreen__btn" isDisabled={!ready || saving}
            aria-label="Скачать draw.io XML" onPress={() => { void download('drawio'); }}>XML</Button>
          <Button variant="ghost" className="drawio-fullscreen__btn" isDisabled={!ready || saving}
            aria-label="Скачать SVG" onPress={() => { void download('svg'); }}>SVG</Button>
          {persisted && <Button variant="ghost" className="drawio-fullscreen__btn" isDisabled={dirty || saving}
            aria-label="Скачать PNG"
            onPress={() => { void download('png'); }}>PNG</Button>}
        </div>
      </div>
      {(error ?? saveError) && <div className="drawio-fullscreen__error" role="alert">{error ?? saveError}</div>}
      <div className="drawio-fullscreen__body">
        {!ready && !error && <div className="drawio-fullscreen__loading" role="status">Загрузка локального draw.io…</div>}
        <iframe ref={iframeRef} className="drawio-fullscreen__frame" title="Редактор draw.io" />
      </div>
      {dialog}
    </div>
  );
}
