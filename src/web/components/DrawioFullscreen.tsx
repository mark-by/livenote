import { useEffect, useRef, useState } from 'react';
import type { Block } from '../../shared/types';
import { ApiError, downloadBlockPng, updateBlock } from '../api';
import { diagramFilename, downloadDiagramSvg, downloadTextFile } from '../svgDownload';
import { useConfirm } from './ConfirmDialog';
import { useDrawioFrame } from './useDrawioFrame';

interface DrawioFullscreenProps {
  block: Block;
  pageTitle: string;
  pageRevision: number;
  onSaved(source: string, revision: number): void;
  onClose(): void;
}

export function DrawioFullscreen({ block, pageTitle, pageRevision, onSaved, onClose }: DrawioFullscreenProps): React.JSX.Element {
  const [draft, setDraft] = useState(block.source);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const draftRef = useRef(draft);
  const dirtyRef = useRef(false);
  const savingRef = useRef(saving);
  const closeRef = useRef(() => undefined as void);
  draftRef.current = draft;
  const dirty = draft !== block.source;
  dirtyRef.current = dirty;
  savingRef.current = saving;

  const { iframeRef, ready, error, exportDiagram } = useDrawioFrame({
    xml: block.source,
    frameKey: block.id,
    onAutosave: (xml) => {
      // autosave меняет только локальный черновик, никаких REST-записей и load.
      setDraft(xml);
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
      const source = await exportDiagram('xml', true);
      if (!source.trim()) throw new Error('draw.io вернул пустой XML');
      const result = await updateBlock(block.pageId, block.id, {
        source, expectedRevision: pageRevision
      });
      if (result.validation?.syntax === 'error') {
        setSaveError(result.validation.error?.message ?? 'Сервер отклонил XML draw.io.');
        return;
      }
      setDraft(source);
      onSaved(source, result.revision);
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
  closeRef.current = () => { void cancel(); };

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
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = 'hidden';
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (dialog !== null) return;
      if (event.key === 'Escape' && !event.defaultPrevented) closeRef.current();
      if (event.key !== 'Tab') return;
      const root = cancelRef.current?.closest('[role="dialog"]');
      const controls = Array.from(root?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), iframe'
      ) ?? []).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!root?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [dialog]);

  return (
    <div className="drawio-fullscreen" role="dialog" aria-modal="true" aria-label={`${pageTitle} — схема draw.io`}>
      <div className="drawio-fullscreen__panel">
        <div className="drawio-fullscreen__heading">
          <span className="drawio-fullscreen__title">{pageTitle}</span>
          {block.title && <span className="drawio-fullscreen__diagram-title">{block.title}</span>}
          <span className="drawio-fullscreen__type">draw.io</span>
          {dirty && <span className="drawio-fullscreen__dirty">Есть несохранённые изменения</span>}
        </div>
        <div className="drawio-fullscreen__controls">
          <button type="button" className="drawio-fullscreen__btn drawio-fullscreen__btn--primary"
            disabled={saving || !ready || error !== null} onClick={() => { void save(); }}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
          <button ref={cancelRef} type="button" className="drawio-fullscreen__btn" disabled={saving}
            onClick={() => { void cancel(); }}>Отмена</button>
          <button type="button" className="drawio-fullscreen__btn" disabled={!ready || saving}
            aria-label="Скачать draw.io XML" onClick={() => { void download('drawio'); }}>XML</button>
          <button type="button" className="drawio-fullscreen__btn" disabled={!ready || saving}
            aria-label="Скачать SVG" onClick={() => { void download('svg'); }}>SVG</button>
          <button type="button" className="drawio-fullscreen__btn" disabled={dirty || saving}
            aria-label="Скачать PNG" title={dirty ? 'Сначала сохраните изменения' : 'Скачать PNG'}
            onClick={() => { void download('png'); }}>PNG</button>
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
