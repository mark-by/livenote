import { useEffect, useRef, useState } from 'react';

export const DRAWIO_FRAME_URL =
  '/drawio/index.html?embed=1&proto=json&offline=1&noSaveBtn=1&noExitBtn=1&saveAndExit=0&contrast=0';

const FRAME_TIMEOUT_MS = 20_000;

type ExportFormat = 'xml' | 'svg';
type DrawioMessage = {
  event?: string;
  requestId?: string;
  message?: { requestId?: string };
  xml?: string;
  data?: string;
  error?: string;
};

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
}

function messageError(message: string): Error {
  return new Error(`Локальный редактор draw.io: ${message}`);
}

function decodeExport(message: DrawioMessage, format: ExportFormat): string {
  if (format === 'xml' && typeof message.xml === 'string') return message.xml;
  const data = message.data;
  if (typeof data !== 'string' || data.length === 0) {
    throw messageError(`пустой ответ экспорта ${format.toUpperCase()}`);
  }
  if (!data.startsWith('data:')) return data;
  const comma = data.indexOf(',');
  if (comma < 0) throw messageError('некорректный data URL');
  const metadata = data.slice(0, comma);
  const payload = data.slice(comma + 1);
  if (metadata.endsWith(';base64')) {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(payload);
}

/**
 * Единственная точка общения с локальным draw.io. Listener устанавливается до src,
 * сообщения принимаются только от локального origin и точного contentWindow.
 */
export function useDrawioFrame({ xml, frameKey, onAutosave }: DrawioFrameOptions) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const xmlRef = useRef(xml);
  const autosaveRef = useRef(onAutosave);
  const pendingRef = useRef(new Map<string, PendingExport>());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const counterRef = useRef(0);
  const generationRef = useRef(0);
  const exportNowRef = useRef<((format: ExportFormat, resetEditor: boolean) => Promise<string>) | null>(null);
  const initializedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  xmlRef.current = xml;
  autosaveRef.current = onAutosave;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const generation = ++generationRef.current;
    const origin = window.location.origin;
    let disposed = false;
    let editorDocumentLoaded = false;
    let finishLoad: (() => void) | null = null;
    let failLoad: ((reason: Error) => void) | null = null;
    initializedRef.current = false;
    setReady(false);
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
      setReady(false);
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
      if (message.event === 'init') {
        initializedRef.current = true;
        // load и все последующие операции идут через одну очередь. Событие load
        // подтверждает, что редактор действительно принял XML.
        queueRef.current = queueRef.current.then(() => new Promise<void>((resolve, reject) => {
          failLoad = reject;
          finishLoad = () => {
            failLoad = null;
            window.clearTimeout(initTimer);
            if (!disposed) setReady(true);
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
    iframe.src = DRAWIO_FRAME_URL;

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
  }, [frameKey]);

  const exportDiagram = (format: ExportFormat, resetEditor = false): Promise<string> => {
    const operation = queueRef.current.then(() => {
      const exportNow = exportNowRef.current;
      return exportNow
        ? exportNow(format, resetEditor)
        : Promise.reject(messageError('редактор закрыт'));
    });
    queueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return { iframeRef, ready, error, exportDiagram };
}
