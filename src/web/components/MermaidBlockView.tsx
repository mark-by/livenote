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
 * Подтверждение зависит от ревизии, а рендер зависит от исходника и темы.
 * Результат отменённого рендера не попадает в видимый контейнер.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import mermaid from 'mermaid';
import type { Block } from '../../shared/types';
import { confirmRendered } from '../api';
import { staticSvgMarkup } from '../svgDownload';
import { ensureMermaidInitialized, getThemeVersion, nextMermaidRenderId, useThemeVersion } from '../mermaidInit';
import { getMermaidPreview, rememberMermaidPreview } from '../diagrams/mermaidPreviewCache';
import { CopyButton } from './CopyButton';
import { ArrowDownToLine, ArrowsExpand } from '@gravity-ui/icons';
import { DiagramAction } from '../diagrams/DiagramAction';
import { downloadMermaid } from '../diagrams/mermaidDownload';

interface MermaidBlockViewProps {
  block: Block;
  /** Текущая ревизия страницы — подтверждаем, какую версию реально видит человек. */
  pageRevision: number;
  /** Открыть диаграмму в полноэкранном режиме (опционально). */
  onExpand?: () => void;
  persisted?: boolean;
}

type RenderOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export function MermaidBlockView({ block, pageRevision, onExpand, persisted = true }: MermaidBlockViewProps): React.JSX.Element {
  // Скрытый контейнер, куда mermaid.render вкладывает результат.
  const renderHostRef = useRef<HTMLDivElement>(null);
  // Видимый контейнер с актуальным SVG.
  const visibleRef = useRef<HTMLDivElement>(null);
  // Новый рендер сразу сбрасывает результат для подтверждения. Старый SVG остаётся видимым.
  const currentOutcomeRef = useRef<RenderOutcome | null>(null);
  // Последний успешный SVG в статичной форме — источник для скачивания файлом.
  const svgRef = useRef<string>('');

  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RenderOutcome | null>(null);
  // Двигает disabled у кнопки скачивания: ref сам по себе re-render не вызывает.
  const [svgReady, setSvgReady] = useState(false);
  // Версия темы mermaid: смена темы из настроек перерисовывает диаграмму.
  const themeVersion = useThemeVersion();
  const { source, id: blockId, pageId } = block;

  useEffect(() => {
    let disposed = false;
    currentOutcomeRef.current = null;
    const renderHost = renderHostRef.current;
    const visible = visibleRef.current;
    if (!renderHost || !visible) {
      return;
    }
    // Очищаем хост перед новым рендером.
    renderHost.innerHTML = '';
    // Хост рендера имеет фиксированную ширину. SVG масштабируется в видимом контейнере.
    const key = JSON.stringify([themeVersion, visible.ownerDocument.URL, source]);
    const isCurrent = () => !disposed && themeVersion === getThemeVersion();

    const finish = (result: RenderOutcome): void => {
      currentOutcomeRef.current = result;
      setOutcome(result);
      setError(result.ok ? null : result.error);
    };

    const show = (svg: string): void => {
      visible.innerHTML = svg;
      // Для скачивания — статичная форма: строгий XML, фикс-размеры, без анимаций.
      svgRef.current = staticSvgMarkup(svg);
      setSvgReady(true);
      finish({ ok: true });
    };

    const cached = isCurrent() ? getMermaidPreview(key, visible) : undefined;
    if (cached !== undefined) show(cached);
    else void (async () => {
      try {
        await ensureMermaidInitialized();
        if (!isCurrent()) return;
        await mermaid.parse(source);
        if (!isCurrent()) return;
        const { svg } = await mermaid.render(nextMermaidRenderId(), source, renderHost);
        if (!isCurrent()) return;
        renderHost.replaceChildren();
        if (!svg) {
          finish({ ok: false, error: 'Mermaid не вернул SVG' });
          return;
        }
        show(svg);
        // Скрытая вкладка не даёт Mermaid измерить макет для повторного использования.
        if (renderHost.getClientRects().length > 0) rememberMermaidPreview(key, svg, visible);
      } catch (failure) {
        if (isCurrent()) finish({ ok: false, error: failure instanceof Error ? failure.message : String(failure) });
      }
    })();

    return () => {
      disposed = true;
    };
  }, [source, themeVersion]);

  useEffect(() => {
    if (!persisted || outcome === null || outcome !== currentOutcomeRef.current || themeVersion !== getThemeVersion()) return;
    const confirmation = { revision: pageRevision, ...outcome };
    void confirmRendered(pageId, blockId, confirmation).catch(() => {
      // Сбой запроса не меняет отображённую диаграмму.
    });
  }, [outcome, persisted, pageId, blockId, pageRevision, source, themeVersion]);

  // Бейдж «предыдущая версия», если сервер знает, что последняя ревизия не отображалась.
  const showStaleBadge =
    block.renderOk === false && block.renderedRevision !== null && block.renderedRevision !== pageRevision;

  return (
    <div className="mermaid-block" data-diagram-pending={!svgReady && error === null ? '' : undefined}>
      {/* Название диаграммы — HTML над схемой, вне SVG (задаётся write_diagram title). */}
      {block.title !== null && block.title !== '' && <div className="diagram-title">{block.title}</div>}
      <div className="mermaid-actions">
        <CopyButton text={block.source} title="Копировать исходник" className="mermaid-copy" />
        {onExpand && <DiagramAction label="Во весь экран" icon={ArrowsExpand} className="mermaid-expand" onPress={onExpand} />}
        <Button variant="primary" size="sm" aria-label="Скачать SVG"
          isDisabled={!svgReady} onPress={() => {
            const svg = svgRef.current;
            if (svg.length > 0) {
              void downloadMermaid('svg', `${block.id}.svg`, block, svg);
            }
          }}><ArrowDownToLine aria-hidden="true" />SVG</Button>
        {persisted && <Button variant="ghost" size="sm" aria-label="Скачать PNG"
          isDisabled={outcome?.ok !== true}
          onPress={() => { void downloadMermaid('png', `${block.id}.png`, block, ''); }}>PNG</Button>}
        <Button variant="ghost" size="sm" aria-label="Скачать исходник Mermaid"
          onPress={() => { void downloadMermaid('mmd', `${block.id}.mmd`, block, block.source); }}>Mermaid</Button>
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
