import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { Block } from '../../shared/types';
import { confirmRendered, downloadBlockPng } from '../api';
import { diagramFilename, downloadDiagramSvg, downloadTextFile } from '../svgDownload';
import { CopyButton } from './CopyButton';
import { useDrawioFrame } from './useDrawioFrame';
import { ArrowsExpand, MagnifierPlus, MagnifierMinus } from '@gravity-ui/icons';
import { DiagramAction } from '../diagrams/DiagramAction';
import { notifyDiagramDownload } from '../diagrams/diagramDownload';

export const EMPTY_DRAWIO_XML =
  '<mxfile><diagram id="livenote" name="Страница 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

interface DrawioBlockViewProps {
  block: Block;
  pageRevision: number;
  pageTitle: string;
  onExpand(): void;
  persisted?: boolean;
}

export function DrawioBlockView({ block, pageRevision, pageTitle, onExpand, persisted = true }: DrawioBlockViewProps): React.JSX.Element {
  const svgRef = useRef('');
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [exportError, setExportError] = useState<string | null>(null);
  const { iframeRef, ready, error, exportDiagram } = useDrawioFrame({
    xml: block.source,
    frameKey: block.source,
    backgroundPreview: true
  });

  useEffect(() => {
    if (!ready) return;
    let current = true;
    setScale(1);
    void exportDiagram('svg').then((svg) => {
      if (!current) return;
      if (!svg.includes('<svg')) throw new Error('draw.io не вернул SVG');
      svgRef.current = svg;
      const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      setSvgUrl(objectUrl);
      setExportError(null);
      if (persisted) void confirmRendered(block.pageId, block.id, { revision: pageRevision, ok: true }).catch(() => undefined);
    }).catch((renderError: unknown) => {
      if (!current) return;
      const message = renderError instanceof Error ? renderError.message : String(renderError);
      setExportError(message);
      if (persisted) void confirmRendered(block.pageId, block.id, {
        revision: pageRevision, ok: false, error: message
      }).catch(() => undefined);
    });
    return () => {
      current = false;
    };
  }, [ready, block.id, block.pageId, pageRevision, persisted]);

  useEffect(() => () => {
    if (svgUrl) URL.revokeObjectURL(svgUrl);
  }, [svgUrl]);

  const downloadPng = (): void => {
    const filename = diagramFilename(pageTitle, block.id, 'png');
    void notifyDiagramDownload(filename, () => downloadBlockPng(block.pageId, block.id, filename));
  };

  const failure = error ?? exportError;
  const showStaleBadge = block.renderOk === false && block.renderedRevision !== null &&
    block.renderedRevision !== pageRevision;

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
          <DiagramAction label="Во весь экран" icon={ArrowsExpand} className="drawio-controls__btn" onPress={onExpand} />
          <DiagramAction label="Приблизить draw.io-схему" icon={MagnifierPlus} className="drawio-controls__btn"
            disabled={!svgUrl} onPress={() => setScale((value) => Math.min(4, value * 1.2))} />
          <DiagramAction label="Отдалить draw.io-схему" icon={MagnifierMinus} className="drawio-controls__btn"
            disabled={!svgUrl} onPress={() => setScale((value) => Math.max(0.2, value / 1.2))} />
          <DiagramAction label="Сбросить масштаб draw.io-схемы" icon={ArrowsExpand} className="drawio-controls__btn"
            disabled={!svgUrl} onPress={() => setScale(1)} />
          <Button variant="ghost" size="sm" className="drawio-controls__btn" aria-label="Скачать draw.io XML"
            onPress={() => {
              const filename = diagramFilename(pageTitle, block.id, 'drawio');
              void notifyDiagramDownload(filename, () => downloadTextFile(block.source, filename, 'application/xml'));
            }}>XML</Button>
          <Button variant="ghost" size="sm" className="drawio-controls__btn" aria-label="Скачать SVG" isDisabled={!svgRef.current}
            onPress={() => {
              const filename = diagramFilename(pageTitle, block.id, 'svg');
              void notifyDiagramDownload(filename, () => downloadDiagramSvg(svgRef.current, filename));
            }}>SVG</Button>
          {persisted && <Button variant="ghost" size="sm" className="drawio-controls__btn" aria-label="Скачать PNG" onPress={downloadPng}>PNG</Button>}
        </div>
      </div>
      <iframe ref={iframeRef} className="drawio-frame-host" title="Локальный рендер draw.io"
        aria-hidden="true" tabIndex={-1} />
      {failure && svgUrl && <div className="drawio-error" role="alert">{failure}</div>}
      {showStaleBadge && <div className="block__badge">Отображается предыдущая версия схемы</div>}
    </div>
  );
}
