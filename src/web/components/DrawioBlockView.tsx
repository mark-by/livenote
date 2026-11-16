import { useEffect, useRef, useState } from 'react';
import type { Block } from '../../shared/types';
import { confirmRendered, downloadBlockPng } from '../api';
import { diagramFilename, downloadDiagramSvg, downloadTextFile } from '../svgDownload';
import { CopyButton } from './CopyButton';
import { useDrawioFrame } from './useDrawioFrame';

export const EMPTY_DRAWIO_XML =
  '<mxfile><diagram id="livenote" name="Страница 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

interface DrawioBlockViewProps {
  block: Block;
  pageRevision: number;
  pageTitle: string;
  onExpand(): void;
}

export function DrawioBlockView({ block, pageRevision, pageTitle, onExpand }: DrawioBlockViewProps): React.JSX.Element {
  const svgRef = useRef('');
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [exportError, setExportError] = useState<string | null>(null);
  const { iframeRef, ready, error, exportDiagram } = useDrawioFrame({
    xml: block.source,
    frameKey: `${block.id}:${block.source}`
  });

  useEffect(() => {
    if (!ready) return;
    let current = true;
    let objectUrl: string | null = null;
    setScale(1);
    void exportDiagram('svg').then((svg) => {
      if (!current) return;
      if (!svg.includes('<svg')) throw new Error('draw.io не вернул SVG');
      svgRef.current = svg;
      objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      setSvgUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return objectUrl;
      });
      setExportError(null);
      void confirmRendered(block.pageId, block.id, { revision: pageRevision, ok: true }).catch(() => undefined);
    }).catch((renderError: unknown) => {
      if (!current) return;
      const message = renderError instanceof Error ? renderError.message : String(renderError);
      setExportError(message);
      void confirmRendered(block.pageId, block.id, {
        revision: pageRevision, ok: false, error: message
      }).catch(() => undefined);
    });
    return () => {
      current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [ready, block.id, block.pageId, pageRevision]);

  useEffect(() => () => {
    if (svgUrl) URL.revokeObjectURL(svgUrl);
  }, [svgUrl]);

  const downloadPng = (): void => {
    setExportError(null);
    void downloadBlockPng(block.pageId, block.id, diagramFilename(pageTitle, block.id, 'png'))
      .catch((downloadError: unknown) => {
        setExportError(downloadError instanceof Error ? downloadError.message : String(downloadError));
      });
  };

  const failure = error ?? exportError;
  const showStaleBadge = block.renderOk === false && block.renderedRevision !== null &&
    block.renderedRevision < pageRevision;

  return (
    <div className="drawio-block">
      {block.title && <div className="diagram-title">{block.title}</div>}
      <div className="drawio-preview">
        {svgUrl ? (
          <div className="drawio-preview__viewport">
            <img
              className="drawio-preview__image"
              src={svgUrl}
              style={{ transform: `scale(${scale})` }}
              alt={block.title ? `Схема ${block.title}` : 'Схема draw.io'}
              draggable={false}
            />
          </div>
        ) : (
          <div className="drawio-preview__status" role="status">
            {failure ?? 'Загрузка локального draw.io…'}
          </div>
        )}
        <div className="drawio-controls" aria-label="Действия со схемой draw.io">
          <CopyButton text={block.source} title="Копировать исходник" className="drawio-controls__btn" />
          <button type="button" className="drawio-controls__btn" onClick={onExpand}
            title="Редактировать на весь экран" aria-label="Во весь экран">⛶</button>
          <button type="button" className="drawio-controls__btn" aria-label="Приблизить draw.io-схему"
            disabled={!svgUrl} onClick={() => setScale((value) => Math.min(4, value * 1.2))}>+</button>
          <button type="button" className="drawio-controls__btn" aria-label="Отдалить draw.io-схему"
            disabled={!svgUrl} onClick={() => setScale((value) => Math.max(0.2, value / 1.2))}>−</button>
          <button type="button" className="drawio-controls__btn" aria-label="Сбросить масштаб draw.io-схемы"
            disabled={!svgUrl} onClick={() => setScale(1)}>Сброс</button>
          <button type="button" className="drawio-controls__btn" aria-label="Скачать draw.io XML"
            onClick={() => downloadTextFile(block.source, diagramFilename(pageTitle, block.id, 'drawio'), 'application/xml')}>XML</button>
          <button type="button" className="drawio-controls__btn" aria-label="Скачать SVG" disabled={!svgRef.current}
            onClick={() => downloadDiagramSvg(svgRef.current, diagramFilename(pageTitle, block.id, 'svg'))}>SVG</button>
          <button type="button" className="drawio-controls__btn" aria-label="Скачать PNG" onClick={downloadPng}>PNG</button>
        </div>
      </div>
      <iframe ref={iframeRef} className="drawio-frame-host" title="Локальный рендер draw.io"
        aria-hidden="true" tabIndex={-1} />
      {failure && svgUrl && <div className="drawio-error" role="alert">{failure}</div>}
      {showStaleBadge && <div className="block__badge">Отображается предыдущая версия схемы</div>}
    </div>
  );
}
