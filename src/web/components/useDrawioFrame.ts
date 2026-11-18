import { useEffect, useRef, useState } from 'react';
import { decodeExport, messageError, DRAWIO_FRAME_URL, DRAWIO_MODAL_EVENT } from '../diagrams/drawioProtocol';
import type { DrawioMessage, ExportFormat } from '../diagrams/drawioProtocol';
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
}

/**
 * Единственная точка общения с локальным draw.io. Listener устанавливается до src,
 * сообщения принимаются только от локального origin и точного contentWindow.
 */
export function useDrawioFrame({ xml, frameKey, onAutosave, backgroundPreview = false }: DrawioFrameOptions) {
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
          discard(messageError(`таймаут экспорта ${format.toUpperCase()}`));
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
      if (event.origin !== origin || event.source !== iframe.contentWindow) return;
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
      // React уничтожит iframe при unmount; при смене frameKey сохраняем элемент
      // для следующего effect, но немедленно выгружаем старый документ.
      iframe.src = 'about:blank';
    };
  }, [loadedFrameKey, backgroundPreview, previewEnabled]);

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

  return { iframeRef, ready, error, exportDiagram };
}
