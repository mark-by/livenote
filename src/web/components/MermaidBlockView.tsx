/**
 * Отображение Mermaid-блока — самое ответственное место интерфейса.
 *
 * Этапы рендера (по спецификации):
 *  (а) mermaid.parse(source) — при ошибке показываем предупреждение и
 *      НЕ трогаем предыдущий отрисованный SVG;
 *  (б) mermaid.render(uniqueId, source) в скрытый контейнер;
 *  (в) только при успехе заменяем содержимое видимого контейнера новым SVG;
 *  (г) после вставки отправляем confirmRendered({revision, ok:true}),
 *      при ошибке — {ok:false, error}.
 *
 * Защита от гонок: каждый рендер получает новый requestId; результат
 * устаревшей версии не вставляется, если появилась более новая.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import mermaid from 'mermaid';
import type { Block } from '../../shared/types';
import { confirmRendered, downloadBlockPng } from '../api';
import { downloadDiagramSvg, staticSvgMarkup } from '../svgDownload';
import { ensureMermaidInitialized, useThemeVersion } from '../mermaidInit';
import { CopyButton } from './CopyButton';
import { ArrowDownToLine, ArrowsExpand } from '@gravity-ui/icons';
import { DiagramAction } from '../diagrams/DiagramAction';
import { downloadTextFile } from '../svgDownload';

interface MermaidBlockViewProps {
  block: Block;
  /** Текущая ревизия страницы — подтверждаем, какую версию реально видит человек. */
  pageRevision: number;
  /** Открыть диаграмму в полноэкранном режиме (опционально). */
  onExpand?: () => void;
  persisted?: boolean;
}

export function MermaidBlockView({ block, pageRevision, onExpand, persisted = true }: MermaidBlockViewProps): React.JSX.Element {
  // Скрытый контейнер, куда mermaid.render вкладывает результат.
  const renderHostRef = useRef<HTMLDivElement>(null);
  // Видимый контейнер с актуальным SVG.
  const visibleRef = useRef<HTMLDivElement>(null);
  // Счётчик запросов: только последний рендер имеет право писать на экран.
  const requestRef = useRef(0);
  // Счётчик уникальных id — mermaid требует новый id при каждом рендере.
  const idCounterRef = useRef(0);
  // Последний успешный SVG в статичной форме — источник для скачивания файлом.
  const svgRef = useRef<string>('');

  const [error, setError] = useState<string | null>(null);
  // Двигает disabled у кнопки скачивания: ref сам по себе re-render не вызывает.
  const [svgReady, setSvgReady] = useState(false);
  // Версия темы mermaid: смена темы из настроек перерисовывает диаграмму.
  const themeVersion = useThemeVersion();

  useEffect(() => {
    let disposed = false;
    const requestId = ++requestRef.current;
    const renderHost = renderHostRef.current;
    const visible = visibleRef.current;
    if (!renderHost || !visible) {
      return;
    }
    // Очищаем хост перед новым рендером.
    renderHost.innerHTML = '';

    const report = (rawError: unknown): void => {
      const message = rawError instanceof Error ? rawError.message : String(rawError);
      setError(message);
      if (!persisted) return;
      void confirmRendered(block.pageId, block.id, { revision: pageRevision, ok: false, error: message }).catch(
        () => {
          // Ошибка подтверждения не критична: главное — не выставлять ok:true ложно.
        }
      );
    };

    void (async () => {
      await ensureMermaidInitialized();

      // (а) Проверка синтаксиса: при ошибке старый SVG остаётся на экране.
      let parsedOk = true;
      try {
        await mermaid.parse(block.source);
      } catch (parseError) {
        parsedOk = false;
        if (!disposed && requestRef.current === requestId) {
          report(parseError);
        }
      }
      if (!parsedOk || disposed || requestRef.current !== requestId) {
        return;
      }

      // (б) Рендер: mermaid возвращает SVG строкой — контейнер не гарантирует вставку.
      let renderResult: Awaited<ReturnType<typeof mermaid.render>> | null = null;
      let renderOk = true;
      try {
        renderResult = await mermaid.render(`livenote-${block.id}-${++idCounterRef.current}`, block.source, renderHost);
      } catch (renderError) {
        renderOk = false;
        if (!disposed && requestRef.current === requestId) {
          report(renderError);
        }
      }
      if (!renderOk || disposed || requestRef.current !== requestId || renderResult === null) {
        return;
      }

      // (в) Только успешный результат последнего запроса попадает в видимый контейнер.
      const svg = renderResult.svg;
      if (typeof svg !== 'string' || svg.length === 0) {
        if (requestRef.current === requestId) {
          report(new Error('Mermaid не вернул SVG'));
        }
        return;
      }
      visible.innerHTML = svg;
      renderHost.innerHTML = '';

      if (disposed || requestRef.current !== requestId) {
        return;
      }
      // Для скачивания — статичная форма: строгий XML, фикс-размеры, без анимаций.
      svgRef.current = staticSvgMarkup(svg);
      setSvgReady(true);
      setError(null);

      // (г) Подтверждаем фактически отображённую ревизию.
      if (persisted) void confirmRendered(block.pageId, block.id, { revision: pageRevision, ok: true }).catch(() => {
        // Ошибка подтверждения не критична для отображения.
      });
    })();

    return () => {
      disposed = true;
    };
    // Рендерим заново при изменении исходника блока или темы mermaid.
  }, [block.source, block.id, block.pageId, pageRevision, themeVersion, persisted]);

  // Бейдж «предыдущая версия», если сервер знает, что последняя ревизия не отображалась.
  const showStaleBadge =
    block.renderOk === false && block.renderedRevision !== null && block.renderedRevision !== pageRevision;

  return (
    <div className="mermaid-block">
      {/* Название диаграммы — HTML над схемой, вне SVG (задаётся write_diagram title). */}
      {block.title !== null && block.title !== '' && <div className="diagram-title">{block.title}</div>}
      <div className="mermaid-actions">
        <CopyButton text={block.source} title="Копировать исходник" className="mermaid-copy" />
        {onExpand && <DiagramAction label="Во весь экран" icon={ArrowsExpand} className="mermaid-expand" onPress={onExpand} />}
        <DiagramAction label="Скачать SVG" icon={ArrowDownToLine} className="mermaid-download"
          disabled={!svgReady} onPress={() => {
            const svg = svgRef.current;
            if (svg.length > 0) {
              downloadDiagramSvg(svg, `${block.id}.svg`);
            }
          }} />
        <Button variant="ghost" size="sm" aria-label="Скачать исходник Mermaid"
          onPress={() => downloadTextFile(block.source, `${block.id}.mmd`, 'text/plain')}>Mermaid</Button>
        {persisted && <Button variant="ghost" size="sm" aria-label="Скачать PNG"
          onPress={() => { void downloadBlockPng(block.pageId, block.id, `${block.id}.png`)
            .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))); }}>PNG</Button>}
      </div>
      {/* Видимый контейнер с актуальным SVG */}
      <div ref={visibleRef} />
      {/* Скрытый хост для рендера (за экраном, но не display:none — чтобы mermaid мог измерить размеры) */}
      <div ref={renderHostRef} className="mermaid-render-host" aria-hidden="true" />

      {error !== null && (
        <div className="mermaid-error" role="alert">
          Ошибка рендера диаграммы: {error}
        </div>
      )}
      {showStaleBadge && (
        <div className="block__badge">Отображается предыдущая версия диаграммы</div>
      )}
    </div>
  );
}
