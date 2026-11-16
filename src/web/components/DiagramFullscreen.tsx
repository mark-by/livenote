/**
 * Полноэкранный просмотр диаграммы: модальное окно с зумом колесиком мыши
 * и перетаскиванием (pan).
 *
 * Два рендер-механизма — по типу блока:
 *  (а) mermaid: parse → render → вставка SVG; зум/пан реализованы вручную
 *      через transform: translate(x,y) scale(s) на контейнере (origin 0 0);
 *  (б) bpmn: bpmn-js NavigatedViewer — зум и пан используем родные жесты
 *      (колесо — панорама, Ctrl/Cmd+колесо — зум, drag — пан), ничего не переопределяем.
 *
 * Модалка НЕ шлёт confirmRendered — это не основной рендер блока: диаграмма
 * уже отрисована в карточке страницы, здесь только удобный просмотр крупным планом.
 */
import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import type Canvas from 'diagram-js/lib/core/Canvas';
import type { Block } from '../../shared/types';
import { downloadBlockPng } from '../api';
import { diagramFilename, downloadDiagramSvg, downloadTextFile, normalizeSvgXml, staticSvgMarkup } from '../svgDownload';
import { ensureMermaidInitialized, useThemeVersion } from '../mermaidInit';
import { DiagramEditorPanel } from './DiagramEditorPanel';
import { useDiagramEditor } from './useDiagramEditor';

// Стили bpmn-js уже загружены BpmnBlockView, но импорт держим, чтобы модалка
// оставалась самодостаточной (Vite дедуплицирует повторную загрузку).
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';

/** Границы масштаба ручного зума. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
/** Множитель зума колесиком мыши. */
const WHEEL_STEP = 1.15;
/** Множитель зума кнопками «+»/«−». */
const BUTTON_STEP = 1.2;

/** Вытащить текст ошибки из неизвестного значения. */
function errorText(rawError: unknown): string {
  return rawError instanceof Error ? rawError.message : String(rawError);
}

interface DiagramFullscreenProps {
  block: Block;
  pageTitle: string;
  pageRevision: number;
  onSaved(source: string, revision: number): void;
  onClose(): void;
}

function DownloadIcon(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

export function DiagramFullscreen({ block, pageTitle, pageRevision, onSaved, onClose }: DiagramFullscreenProps): React.JSX.Element {
  const editor = useDiagramEditor({ block, pageRevision, onSaved, onClose });
  const editorRef = useRef(editor);
  editorRef.current = editor;
  // Кнопка «Закрыть» — на неё переводим фокус при открытии модалки.
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // onClose держим в ref, чтобы keydown-listener на document создавался один раз.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = () => { void editor.close(); };

  // Ошибка parse/render/importXML — выводится на панель, диаграмма не показывается.
  const [error, setError] = useState<string | null>(null);

  // --- Общие UI-контейнеры ---------------------------------------------------
  // Зум-пан область для mermaid (canvas с transform) и хост для bpmn viewer.
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgHostRef = useRef<HTMLDivElement>(null);
  const bpmnHostRef = useRef<HTMLDivElement>(null);
  // Последняя успешно отрендеренная SVG-строка mermaid — источник для скачивания.
  const mermaidSvgRef = useRef<string>('');
  // Viewer bpmn держим в ref, чтобы кнопка «SVG» могла вызвать saveSVG() отсюда
  // (внутри useEffect он был до этого локальной переменной).
  const bpmnViewerRef = useRef<NavigatedViewer | null>(null);

  // --- Ручной зум/пан для mermaid ------------------------------------------
  const idCounterRef = useRef(0); // уникальные id для mermaid.render
  // Текущее состояние transform: translate(x,y) scale(s), origin 0 0.
  const transformRef = useRef({ x: 0, y: 0, s: 1 });
  const draggingRef = useRef(false);
  const dragLastRef = useRef({ x: 0, y: 0 });

  // Применить текущее transform к канвасу.
  const applyTransform = (): void => {
    const canvas = canvasRef.current;
    const t = transformRef.current;
    if (canvas) {
      canvas.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})`;
    }
  };

  // Зум к точке (mx, my) внутри канваса: точка, находящаяся под курсором,
  // должна остаться на месте после масштабирования.
  const zoomAt = (nextScale: number, mx: number, my: number): void => {
    const t = transformRef.current;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    const ratio = s / t.s;
    t.x = mx - (mx - t.x) * ratio;
    t.y = my - (my - t.y) * ratio;
    t.s = s;
    applyTransform();
  };

  // Вписать SVG в область и отцентрировать (fit).
  const fitDiagram = (): void => {
    const canvas = canvasRef.current;
    const svgHost = svgHostRef.current;
    const svg = svgHost?.querySelector('svg');
    if (!canvas || !svg) {
      return;
    }
    const area = canvas.parentElement?.getBoundingClientRect();
    if (!area) return;
    const bounds = svg.getBoundingClientRect();
    const areaW = area.width;
    const areaH = area.height;
    const svgW = bounds.width / transformRef.current.s;
    const svgH = bounds.height / transformRef.current.s;
    if (areaW <= 0 || areaH <= 0 || svgW <= 0 || svgH <= 0) {
      return;
    }
    const t = transformRef.current;
    // Не увеличиваем диаграмму, которая и так целиком помещается в область.
    t.s = Math.min(areaW / svgW, areaH / svgH, 1);
    t.x = (areaW - svgW * t.s) / 2;
    t.y = (areaH - svgH * t.s) / 2;
    applyTransform();
  };

  // Кнопки панели: зум вокруг центра области; «Сброс» = fit.
  const zoomIn = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(transformRef.current.s * BUTTON_STEP, rect.width / 2, rect.height / 2);
  };

  const zoomOut = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(transformRef.current.s / BUTTON_STEP, rect.width / 2, rect.height / 2);
  };

  const resetZoom = (): void => {
    fitDiagram();
  };

  useEffect(() => {
    const area = canvasRef.current?.parentElement;
    if (block.type !== 'mermaid' || !area) return;
    const observer = new ResizeObserver(() => fitDiagram());
    observer.observe(area);
    return () => observer.disconnect();
  }, [block.type]);

  // Скачивание схемы: PNG — серверный рендер с прозрачным фоном (работает для
  // обоих форматов); BPMN — редактируемый XML-исходник; SVG — mermaid из
  // сохранённого renderResult.svg (статичный), bpmn — saveSVG().
  const downloadDiagram = (format: 'png' | 'svg' | 'bpmn'): void => {
    if (format === 'png') {
      void downloadBlockPng(block.pageId, block.id, diagramFilename(pageTitle, block.id, 'png')).catch(
        (error: unknown) => {
          console.error('Не удалось скачать PNG:', error);
        }
      );
      return;
    }
    if (format === 'bpmn') {
      downloadTextFile(block.source, diagramFilename(pageTitle, block.id, 'bpmn'), 'application/xml');
      return;
    }
    const deliver = (svg: string): void => {
      downloadDiagramSvg(svg, diagramFilename(pageTitle, block.id, 'svg'));
    };
    if (block.type === 'mermaid') {
      const svg = mermaidSvgRef.current;
      if (svg.length > 0) {
        deliver(svg);
      }
      return;
    }
    const viewer = bpmnViewerRef.current;
    if (!viewer) {
      return;
    }
    void viewer
      .saveSVG()
      .then(({ svg }) => {
        deliver(svg);
      })
      .catch((saveError: unknown) => {
        console.error('Не удалось сохранить BPMN-схему в SVG:', saveError);
      });
  };

  // --- Рендер mermaid + собственные слушатели зума/пана --------------------
  // Смена темы из настроек перерисовывает диаграмму.
  const themeVersion = useThemeVersion();
  useEffect(() => {
    if (block.type !== 'mermaid') {
      return;
    }
    let disposed = false;
    const canvas = canvasRef.current;
    const svgHost = svgHostRef.current;
    if (!canvas || !svgHost) {
      return;
    }

    // Собственный wheel-зум к точке курсора (passive: false — чтобы preventDefault).
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const step = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      zoomAt(transformRef.current.s * step, mx, my);
    };

    // Панорамирование: pointer capture на канвасе, чтобы драг не обрывался,
    // когда курсор выходит за границы области.
    const onPointerDown = (event: PointerEvent): void => {
      if (editorRef.current.editing && event.target instanceof Element &&
        event.target.closest('.node, .flowchart-link, path.relation')) return;
      // Только левая кнопка мыши.
      if (event.button !== 0) {
        return;
      }
      draggingRef.current = true;
      dragLastRef.current = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('diagram-fullscreen__canvas--dragging');
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!draggingRef.current) {
        return;
      }
      const t = transformRef.current;
      t.x += event.clientX - dragLastRef.current.x;
      t.y += event.clientY - dragLastRef.current.y;
      dragLastRef.current = { x: event.clientX, y: event.clientY };
      applyTransform();
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!draggingRef.current) {
        return;
      }
      draggingRef.current = false;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      canvas.classList.remove('diagram-fullscreen__canvas--dragging');
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    const renderId = `livenote-fs-${block.id}-${++idCounterRef.current}`;

    void (async () => {
      await ensureMermaidInitialized();
      if (disposed) return;
      // (а) Проверка синтаксиса: при ошибке диаграмма не показывается.
      try {
        await mermaid.parse(editor.source);
      } catch (parseError) {
        if (!disposed) {
          setError(errorText(parseError));
        }
        return;
      }
      if (disposed) return;
      // (б) Рендер в SVG-строку.
      let svg = '';
      try {
        svg = (await mermaid.render(renderId, editor.source)).svg;
      } catch (renderError) {
        if (!disposed) {
          setError(errorText(renderError));
        }
        return;
      }
      if (disposed || typeof svg !== 'string' || svg.length === 0) {
        if (!disposed) {
          setError('Mermaid не вернул SVG');
        }
        return;
      }
      // (в) Вставка SVG в контейнер и fit (вписать в область при открытии).
      svgHost.innerHTML = svg;
      editorRef.current.decorate(svgHost);
      // Для скачивания — статичная форма: строгий XML, фикс-размеры, без анимаций.
      mermaidSvgRef.current = staticSvgMarkup(svg);
      setError(null);
      fitDiagram();
    })();

    return () => {
      disposed = true;
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
    // Модалка пересоздаётся при каждом открытии; перерендер нужен от смены исходника или темы.
  }, [block.type, editor.source, block.id, themeVersion]);

  useEffect(() => {
    if (svgHostRef.current) editor.decorate(svgHostRef.current);
  }, [editor.selection, editor.editing]);

  // --- Рендер bpmn через NavigatedViewer: зум/пан — родные жесты bpmn-js ---
  useEffect(() => {
    if (block.type !== 'bpmn') {
      return;
    }
    const host = bpmnHostRef.current;
    if (!host) {
      return;
    }
    let disposed = false;

    try {
      bpmnViewerRef.current = new NavigatedViewer({ container: host });
    } catch (viewerError) {
      setError(errorText(viewerError));
      return;
    }

    const viewer = bpmnViewerRef.current;
    const canvas = viewer.get<Canvas>('canvas');

    void viewer
      .importXML(block.source)
      .then(() => {
        if (disposed) {
          return;
        }
        // Вписываем схему в область при открытии.
        canvas.zoom('fit-viewport');
        setError(null);
      })
      .catch((importError: unknown) => {
        if (disposed) {
          return;
        }
        setError(errorText(importError));
      });

    return () => {
      disposed = true;
      bpmnViewerRef.current = null;
      viewer.destroy();
    };
  }, [block.type, block.source, block.id]);

  // --- Закрытие по Esc + блокировка скролла body --------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (editorRef.current.dialog !== null) return;
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        onCloseRef.current();
      }
      if (event.key === 'Tab') {
        const dialog = closeBtnRef.current?.closest('[role="dialog"]');
        const controls = Array.from(dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary'
        ) ?? []).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (!dialog?.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    // Пока модалка открыта, страница под ней не должна прокручиваться.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Фокус на кнопке «Закрыть» при открытии модалки.
  useEffect(() => {
    const previousFocus = document.activeElement;
    closeBtnRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  const formatLabel = block.type === 'mermaid' ? 'Mermaid' : 'BPMN';

  return (
    <div
      className="diagram-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label={`${pageTitle} — схема ${formatLabel}`}
    >
      {/* Верхняя панель: заголовок, ошибка при её наличии, кнопки управления. */}
      <div className="diagram-fullscreen__panel">
        <div className="diagram-fullscreen__heading">
          <span className="diagram-fullscreen__title">{pageTitle}</span>
          {block.title !== null && block.title !== '' && (
            <span className="diagram-fullscreen__diagram-title">{block.title}</span>
          )}
          <span className="diagram-fullscreen__type">{formatLabel}</span>
        </div>
        {error !== null && (
          <div className="diagram-fullscreen__error" role="alert">
            Ошибка рендера диаграммы: {error}
          </div>
        )}
        <div className="diagram-fullscreen__controls">
          {block.type === 'mermaid' && (editor.editing ? (
            <>
              <button type="button" className="diagram-fullscreen__btn diagram-fullscreen__btn--primary"
                disabled={!editor.dirty || editor.saving || editor.error !== null || error !== null}
                onClick={() => { void editor.save(); }}>
                {editor.saving ? 'Сохранение…' : 'Сохранить'}
              </button>
              <button type="button" className="diagram-fullscreen__btn" disabled={editor.saving}
                onClick={() => { void editor.cancel(); }}>Отмена</button>
            </>
          ) : (
            <button type="button" className="diagram-fullscreen__btn" onClick={editor.start}
              disabled={editor.model === null}
              title={editor.model === null
                ? 'Визуальный редактор поддерживает flowchart, graph и classDiagram; эта конструкция пока не поддерживается'
                : 'Изменить узлы и связи на схеме'}>Редактировать</button>
          ))}
          <button
            type="button"
            className="diagram-fullscreen__btn"
            onClick={zoomIn}
            title="Приблизить"
            aria-label="Приблизить"
            onPointerDown={(event) => event.stopPropagation()}
          >
            +
          </button>
          <button
            type="button"
            className="diagram-fullscreen__btn"
            onClick={zoomOut}
            title="Отдалить"
            aria-label="Отдалить"
            onPointerDown={(event) => event.stopPropagation()}
          >
            −
          </button>
          <button
            type="button"
            className="diagram-fullscreen__btn"
            onClick={resetZoom}
            title="Вписать схему в область"
            aria-label="Сбросить масштаб"
            onPointerDown={(event) => event.stopPropagation()}
          >
            Сброс
          </button>
          {block.type === 'bpmn' && (
            <button
              type="button"
              className="diagram-fullscreen__btn"
              onClick={() => downloadDiagram('bpmn')}
              title="Скачать BPMN XML (редактируемый исходник)"
              aria-label="Скачать BPMN XML"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <DownloadIcon />
              <span>BPMN</span>
            </button>
          )}
          <button
            type="button"
            className="diagram-fullscreen__btn"
            onClick={() => downloadDiagram('svg')}
            title="Скачать SVG (статичная картинка для досок)"
            aria-label="Скачать SVG"
            disabled={editor.editing}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DownloadIcon />
            <span>SVG</span>
          </button>
          {block.type === 'mermaid' && (
            <button
              type="button"
              className="diagram-fullscreen__btn"
              onClick={() => downloadDiagram('png')}
              title="Скачать PNG (прозрачный фон)"
              aria-label="Скачать PNG"
              disabled={editor.editing}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <DownloadIcon />
              <span>PNG</span>
            </button>
          )}
          <button
            ref={closeBtnRef}
            type="button"
            className="diagram-fullscreen__btn diagram-fullscreen__btn--close"
            onClick={() => { void editor.close(); }}
            disabled={editor.saving}
            title="Закрыть"
            aria-label="Закрыть"
            onPointerDown={(event) => event.stopPropagation()}
          >
            Закрыть
          </button>
        </div>
      </div>

      {/* Зум-пан область на весь оставшийся экран. */}
      <div className="diagram-fullscreen__workspace">
      <div className="diagram-fullscreen__body">
        {block.type === 'mermaid' ? (
          <div className={`diagram-fullscreen__canvas${editor.editing ? ' diagram-fullscreen__canvas--editing' : ''}`} ref={canvasRef}>
            <div className="diagram-fullscreen__svg" ref={svgHostRef} onClick={editor.selectFromDiagram} />
          </div>
        ) : (
          <div className="diagram-fullscreen__bpmn" ref={bpmnHostRef} />
        )}
      </div>
      {editor.editing && <DiagramEditorPanel editor={editor} />}
      </div>
      {editor.dialog}
    </div>
  );
}
