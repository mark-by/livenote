import { useEffect, useRef, useState } from 'react';
import { decodeExport, messageError, DRAWIO_FRAME_URL, DRAWIO_MODAL_EVENT } from '../diagrams/drawioProtocol';
import type { DrawioMessage, ExportFormat } from '../diagrams/drawioProtocol';
import type { AgentElementRef } from '../../shared/types';
export { DRAWIO_FRAME_URL, DRAWIO_MODAL_EVENT } from '../diagrams/drawioProtocol';

const FRAME_TIMEOUT_MS = 20_000;

interface PendingExport {
  format: ExportFormat;
  resolve(value: string): void;
  reject(error: Error): void;
  timer: number;
}

interface DrawioFrameOptions {
  xml: string;
  /** Изменение ключа пересоздаёт iframe. В редакторе ключ не зависит от autosave. */
  frameKey: string;
  onAutosave?(xml: string): void;
  /** Фоновый preview не должен забирать фокус у открытого fullscreen-редактора. */
  backgroundPreview?: boolean;
  agentContext?: boolean;
  agentLocked?: boolean;
}

interface DrawioCell { getId(): string }

interface DrawioUi {
  setFileData(...args: unknown[]): unknown;
  currentPage?: { getId(): string };
  editor: {
    modified: boolean;
    undoManager: { undo(): void; redo(): void };
    graph: {
      container: HTMLElement;
      model: { execute(change: unknown): void };
      getSelectionCells(): DrawioCell[];
      setSelectionCells(cells: DrawioCell[]): void;
      isEditing(): boolean;
      stopEditing(cancel: boolean): void;
      isCellEditable(cell: DrawioCell): boolean;
      isCellMovable(cell: DrawioCell): boolean;
    };
  };
}

function watchDrawioLoad(frame: HTMLIFrameElement, onReady: (ui: DrawioUi) => void): () => void {
  const win = frame.contentWindow as (Window & { EditorUi?: { prototype: DrawioUi } }) | null;
  if (win?.location.origin !== window.location.origin || win.location.pathname !== '/drawio/index.html') {
    throw messageError('недоступен локальный редактор для чтения выделения');
  }
  const prototype = win.EditorUi?.prototype;
  const original = prototype?.setFileData;
  if (!prototype || typeof original !== 'function') throw messageError('не найден мост выделения draw.io');
  const restore = (): void => {
    if (prototype.setFileData === intercept) prototype.setFileData = original;
  };
  function intercept(this: DrawioUi, ...args: unknown[]): unknown {
    try {
      const result = original?.apply(this, args);
      onReady(this);
      return result;
    } finally { restore(); }
  }
  prototype.setFileData = intercept;
  return restore;
}

function protectDrawio(ui: DrawioUi, locked: () => boolean): () => void {
  const { graph, undoManager } = ui.editor;
  const execute = graph.model.execute.bind(graph.model);
  const editable = graph.isCellEditable.bind(graph);
  const movable = graph.isCellMovable.bind(graph);
  const undo = undoManager.undo.bind(undoManager);
  const redo = undoManager.redo.bind(undoManager);
  graph.model.execute = change => { if (!locked()) execute(change); };
  graph.isCellEditable = cell => !locked() && editable(cell);
  graph.isCellMovable = cell => !locked() && movable(cell);
  undoManager.undo = () => { if (!locked()) undo(); };
  undoManager.redo = () => { if (!locked()) redo(); };
  // Изменения списка страниц и другие действия меню могут идти мимо модели графа.
  const doc = graph.container.ownerDocument;
  const gate = (event: Event): void => {
    if (!locked()) return;
    const target = event.target;
    if (target && 'nodeType' in target && graph.container.contains(target as Node)
      && (event.type === 'pointerdown' || event.type === 'click')) return;
    if (event.type === 'keydown' && 'key' in event && (event.key === 'Tab' || event.key === 'Escape')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const events = ['pointerdown', 'click', 'dblclick', 'contextmenu', 'keydown', 'paste', 'drop'];
  for (const name of events) doc.addEventListener(name, gate, true);
  return () => { for (const name of events) doc.removeEventListener(name, gate, true); };
}

/**
 * Единственная точка общения с локальным draw.io. Listener устанавливается до src,
 * сообщения принимаются только от локального origin и точного contentWindow.
 */
export function useDrawioFrame({ xml, frameKey, onAutosave, backgroundPreview = false, agentContext = false,
  agentLocked = false }: DrawioFrameOptions) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const xmlRef = useRef(xml);
  const autosaveRef = useRef(onAutosave);
  const pendingRef = useRef(new Map<string, PendingExport>());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const counterRef = useRef(0);
  const generationRef = useRef(0);
  const exportNowRef = useRef<((format: ExportFormat, resetEditor: boolean) => Promise<string>) | null>(null);
  const initializedRef = useRef(false);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const readyRef = useRef(false);
  const uiRef = useRef<DrawioUi | null>(null);
  const bridgeErrorRef = useRef<Error | null>(null);
  const lockedRef = useRef(agentLocked);
  lockedRef.current = agentLocked;
  const [error, setError] = useState<string | null>(null);
  const [previewEnabled, setPreviewEnabled] = useState(() =>
    !backgroundPreview || document.querySelector('.drawio-fullscreen__frame') === null
  );
  const modalOpenRef = useRef(document.querySelector('.drawio-fullscreen__frame') !== null);
  const requestedKeyRef = useRef(frameKey);
  const [loadedFrameKey, setLoadedFrameKey] = useState(frameKey);
  const ready = readyKey === loadedFrameKey && loadedFrameKey === frameKey;
  xmlRef.current = xml;
  readyRef.current = ready;
  autosaveRef.current = onAutosave;
  requestedKeyRef.current = frameKey;

  useEffect(() => {
    if (!backgroundPreview) return;
    const onModal = (event: Event): void => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.open !== 'boolean') return;
      modalOpenRef.current = event.detail.open;
      if (modalOpenRef.current && !readyRef.current) setPreviewEnabled(false);
      if (!modalOpenRef.current) {
        setLoadedFrameKey(requestedKeyRef.current);
        setPreviewEnabled(true);
      }
    };
    window.addEventListener(DRAWIO_MODAL_EVENT, onModal);
    return () => window.removeEventListener(DRAWIO_MODAL_EVENT, onModal);
  }, [backgroundPreview]);

  useEffect(() => {
    if (!backgroundPreview || !modalOpenRef.current) setLoadedFrameKey(frameKey);
  }, [frameKey, backgroundPreview]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (backgroundPreview && !previewEnabled) {
      setReadyKey(null);
      return;
    }
    // Уже загруженный preview остаётся живым при открытии fullscreen.
    iframe.inert = backgroundPreview;
    const generation = ++generationRef.current;
    const origin = window.location.origin;
    let disposed = false;
    let editorDocumentLoaded = false;
    let finishLoad: (() => void) | null = null;
    let failLoad: ((reason: Error) => void) | null = null;
    let restoreBridge: (() => void) | undefined;
    let removeProtection: (() => void) | undefined;
    const clearBridge = (): void => {
      restoreBridge?.();
      removeProtection?.();
      uiRef.current = null;
    };
    bridgeErrorRef.current = null;
    initializedRef.current = false;
    setReadyKey(null);
    setError(null);

    const rejectPending = (reason: Error): void => {
      for (const pending of pendingRef.current.values()) {
        window.clearTimeout(pending.timer);
        pending.reject(reason);
      }
      pendingRef.current.clear();
    };

    const discard = (reason: Error): void => {
      if (disposed || generationRef.current !== generation) return;
      disposed = true;
      window.clearTimeout(initTimer);
      rejectPending(reason);
      failLoad?.(reason);
      failLoad = null;
      clearBridge();
      setReadyKey(null);
      setError(reason.message);
      // iframe принадлежит React: не удаляем DOM-узел, который может быть
      // повторно использован следующим effect (в том числе в StrictMode).
      iframe.src = 'about:blank';
    };

    const post = (message: Record<string, unknown>): void => {
      if (disposed || iframe.contentWindow === null) {
        throw messageError('окно редактора недоступно');
      }
      iframe.contentWindow.postMessage(JSON.stringify(message), origin);
    };

    const exportNow = (format: ExportFormat, resetEditor: boolean): Promise<string> => {
      if (disposed || !initializedRef.current) {
        return Promise.reject(messageError('редактор ещё не загружен'));
      }
      if (resetEditor) post({ action: 'resetEditor' });
      const requestId = `drawio-${generation}-${++counterRef.current}`;
      return new Promise<string>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pendingRef.current.delete(requestId);
          // Ошибка экспорта не должна выгружать живой черновик.
          reject(messageError(`таймаут экспорта ${format.toUpperCase()}`));
        }, FRAME_TIMEOUT_MS);
        pendingRef.current.set(requestId, { format, resolve, reject, timer });
        try {
          const exportMessage: Record<string, unknown> = { action: 'export', format, requestId };
          if (format === 'svg') exportMessage.theme = 'light';
          post(exportMessage);
        } catch (postError) {
          window.clearTimeout(timer);
          pendingRef.current.delete(requestId);
          reject(postError instanceof Error ? postError : messageError(String(postError)));
        }
      });
    };

    exportNowRef.current = exportNow;

    const onMessage = (event: MessageEvent): void => {
      if (disposed || event.origin !== origin || event.source !== iframe.contentWindow) return;
      let message: DrawioMessage;
      try {
        message = JSON.parse(String(event.data)) as DrawioMessage;
      } catch {
        return;
      }
      if (message.event === 'configure' && backgroundPreview) {
        post({ action: 'configure', config: { noAutoFocus: true } });
        return;
      }
      if (message.event === 'init') {
        if (initializedRef.current) return;
        if (agentContext && !backgroundPreview) {
          try {
            restoreBridge = watchDrawioLoad(iframe, ui => {
              removeProtection = protectDrawio(ui, () => lockedRef.current);
              uiRef.current = ui;
            });
          } catch (error) {
            bridgeErrorRef.current = error instanceof Error ? error : messageError(String(error));
          }
        }
        initializedRef.current = true;
        // load и все последующие операции идут через одну очередь. Событие load
        // подтверждает, что редактор действительно принял XML.
        queueRef.current = queueRef.current.then(() => new Promise<void>((resolve, reject) => {
          failLoad = reject;
          finishLoad = () => {
            failLoad = null;
            window.clearTimeout(initTimer);
            if (!disposed) setReadyKey(loadedFrameKey);
            resolve();
          };
          try {
            post({ action: 'load', xml: xmlRef.current, autosave: 1 });
          } catch (loadError) {
            reject(loadError);
          }
        })).catch((loadError: unknown) => {
          discard(loadError instanceof Error ? loadError : messageError(String(loadError)));
        });
        return;
      }
      if (message.event === 'load') {
        if (!backgroundPreview) post({ action: 'fit', maxScale: 1 });
        finishLoad?.();
        finishLoad = null;
        return;
      }
      if (message.event === 'autosave' && typeof message.xml === 'string') {
        autosaveRef.current?.(message.xml);
        return;
      }
      if (message.event !== 'export') return;
      const requestId = message.message?.requestId ?? message.requestId;
      if (typeof requestId !== 'string') return;
      const pending = pendingRef.current.get(requestId);
      if (!pending) return;
      pendingRef.current.delete(requestId);
      window.clearTimeout(pending.timer);
      try {
        if (message.error) throw messageError(message.error);
        pending.resolve(decodeExport(message, pending.format));
      } catch (exportError) {
        pending.reject(exportError instanceof Error ? exportError : messageError(String(exportError)));
      }
    };

    const onLoad = (): void => {
      let pathname: string;
      try {
        pathname = iframe.contentWindow?.location.pathname ?? '';
      } catch {
        discard(messageError('iframe был перенаправлен на чужой origin'));
        return;
      }
      if (pathname === '/drawio/index.html') {
        if (editorDocumentLoaded) {
          discard(messageError('iframe был перезагружен; незавершённые операции отменены'));
        } else {
          editorDocumentLoaded = true;
        }
        return;
      }
      // about:blank из StrictMode cleanup может завершиться уже после установки
      // нового src. Это не навигация загруженного редактора.
      if (!editorDocumentLoaded && pathname === 'blank') return;
      if (editorDocumentLoaded) {
        discard(messageError('iframe был перенаправлен; незавершённые операции отменены'));
      }
    };

    const initTimer = window.setTimeout(() => {
      discard(messageError('таймаут загрузки'));
    }, FRAME_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    iframe.addEventListener('load', onLoad);
    // Только теперь, после listener, разрешается навигация iframe.
    iframe.src = backgroundPreview ? `${DRAWIO_FRAME_URL}&configure=1` : DRAWIO_FRAME_URL;

    return () => {
      disposed = true;
      generationRef.current += 1;
      window.clearTimeout(initTimer);
      window.removeEventListener('message', onMessage);
      iframe.removeEventListener('load', onLoad);
      rejectPending(messageError('операция отменена закрытием редактора'));
      failLoad?.(messageError('загрузка отменена закрытием редактора'));
      failLoad = null;
      exportNowRef.current = null;
      clearBridge();
      // React уничтожит iframe при unmount; при смене frameKey сохраняем элемент
      // для следующего effect, но немедленно выгружаем старый документ.
      iframe.src = 'about:blank';
    };
  }, [loadedFrameKey, backgroundPreview, previewEnabled, agentContext]);

  const exportDiagram = (format: ExportFormat, resetEditor = false): Promise<string> => {
    const exportNow = exportNowRef.current;
    const operation = queueRef.current.then(() => {
      return exportNow
        ? exportNow(format, resetEditor)
        : Promise.reject(messageError('редактор закрыт'));
    });
    queueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const capture = () => {
    const ui = uiRef.current;
    if (!ready || !ui) throw bridgeErrorRef.current ?? messageError('выделение недоступно: редактор ещё не загрузил схему');
    const pageId = ui.currentPage?.getId();
    const { graph } = ui.editor;
    const cells = graph.getSelectionCells();
    const selected: AgentElementRef[] = cells.map(cell => ({
      id: cell.getId(), kind: 'element', ...(pageId !== undefined ? { pageId } : {})
    }));
    // Завершаем ввод до блокировки модели. resetEditor также закрывает меню.
    const modified = ui.editor.modified || graph.isEditing();
    if (graph.isEditing()) graph.stopEditing(false);
    const source = exportDiagram('xml', true).then(exported => {
      if (ui === uiRef.current && pageId === ui.currentPage?.getId() && graph.getSelectionCells().length === 0) {
        graph.setSelectionCells(cells);
      }
      return modified ? exported : xmlRef.current;
    });
    return { selected, source };
  };

  return { iframeRef, ready, error, exportDiagram, capture };
}
