/**
 * Отображение BPMN-блока через bpmn-js NavigatedViewer (только просмотр,
 * редактирование мышью вне первой версии).
 *
 * Паттерн рендера симметричен MermaidBlockView:
 *  (а) importXML(source) — при ошибке НЕ трогаем предыдущий отрисованный контент,
 *      показываем предупреждение «Отображается предыдущая версия схемы» и текст ошибки;
 *  (б) при успехе — canvas.zoom('fit-viewport'), очистка ошибки,
 *      confirmRendered({revision, ok:true});
 *  (в) при ошибке — confirmRendered({ok:false, error}).
 *
 * Защита от гонок: каждый importXML получает новый requestId; результат устаревшего
 * запроса не влияет на состояние, если появился более новый. viewer создаётся лениво
 * один раз на время жизни компонента и НЕ пересоздаётся при изменении source —
 * только повторный importXML.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import type Canvas from 'diagram-js/lib/core/Canvas';
import type { Block } from '../../shared/types';
import { confirmRendered } from '../api';
import { downloadDiagramSvg, downloadTextFile } from '../svgDownload';
import { notifyDiagramDownload } from '../diagrams/diagramDownload';
import { CopyButton } from './CopyButton';
import { ArrowDownToLine, ArrowsExpand, MagnifierPlus, MagnifierMinus } from '@gravity-ui/icons';
import { DiagramAction } from '../diagrams/DiagramAction';

// Стили bpmn-js: базовый рендер диаграммы + шрифт-иконки (встроены base64,
// внешние сетевые ресурсы не подгружаются).
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';

interface BpmnBlockViewProps {
  block: Block;
  /** Текущая ревизия страницы — подтверждаем, какую версию реально видит человек. */
  pageRevision: number;
  /** Открыть диаграмму в полноэкранном режиме (опционально). */
  onExpand?: () => void;
  persisted?: boolean;
}

export function BpmnBlockView({ block, pageRevision, onExpand, persisted = true }: BpmnBlockViewProps): React.JSX.Element {
  // Контейнер, куда bpmn-js вкладывает свой .djs-container.
  const hostRef = useRef<HTMLDivElement>(null);
  // Единственный экземпляр viewer на время жизни компонента.
  const viewerRef = useRef<NavigatedViewer | null>(null);
  // Счётчик запросов: только последний importXML имеет право писать состояние.
  const requestRef = useRef(0);

  const [error, setError] = useState<string | null>(null);

  // Лениво получить viewer: создаём один экземпляр при первом обращении.
  const getViewer = (): NavigatedViewer | null => {
    const host = hostRef.current;
    if (!host) {
      return null;
    }
    if (viewerRef.current === null) {
      viewerRef.current = new NavigatedViewer({ container: host });
    }
    return viewerRef.current;
  };

  useEffect(() => {
    let disposed = false;
    const requestId = ++requestRef.current;
    const viewer = getViewer();
    if (!viewer) {
      return;
    }
    const canvas = viewer.get<Canvas>('canvas');

    const isCurrent = (): boolean => !disposed && requestRef.current === requestId;

    // Подтверждение серверу и показ ошибки при неудачном импорте.
    const report = (rawError: unknown): void => {
      const message = rawError instanceof Error ? rawError.message : String(rawError);
      setError(message);
      if (!persisted) return;
      void confirmRendered(block.pageId, block.id, {
        revision: pageRevision,
        ok: false,
        error: message
      }).catch(() => {
        // Ошибка подтверждения не критична: главное — не выставлять ok:true ложно.
      });
    };

    // Пустой исходник — очищаем холст, ошибку и ничего не подтверждаем.
    if (block.source.trim().length === 0) {
      viewer.clear();
      setError(null);
      return;
    }

    // (а) Импорт XML: старый контент остаётся на экране при ошибке.
    void viewer
      .importXML(block.source)
      .then(() => {
        if (!isCurrent()) {
          return;
        }
        // (б) Только успех последнего запроса: фит по вьюпорту и подтверждение.
        canvas.zoom('fit-viewport');
        setError(null);
        if (persisted) void confirmRendered(block.pageId, block.id, { revision: pageRevision, ok: true }).catch(() => {
          // Ошибка подтверждения не критична для отображения.
        });
      })
      .catch((importError: unknown) => {
        if (!isCurrent()) {
          return;
        }
        // (в) Ошибка: предыдущий контент не трогаем, сообщаем серверу.
        report(importError);
      });

    return () => {
      disposed = true;
    };
    // Рендерим заново при изменении исходника блока (повторный importXML, не новый viewer).
  }, [block.source, block.id, block.pageId, pageRevision, persisted]);

  // Уничтожаем viewer при размонтировании компонента.
  useEffect(() => {
    return () => {
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  // --- Кнопки управления масштабом -----------------------------------------

  const zoomBy = (factor: number): void => {
    const canvas = viewerRef.current?.get<Canvas>('canvas');
    if (canvas) canvas.zoom(canvas.zoom() * factor);
  };

  const zoomToFit = (): void => {
    const canvas = viewerRef.current?.get<Canvas>('canvas');
    canvas?.zoom('fit-viewport');
  };

  // Скачивание схемы в SVG: saveSVG возвращает текущее состояние холста как строку.
  const downloadSvg = (): void => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }
    const filename = `${block.id}.svg`;
    void notifyDiagramDownload(filename, async () => {
      const { svg } = await viewer.saveSVG();
      return downloadDiagramSvg(svg, filename);
    });
  };

  // Бейдж «предыдущая версия», если сервер знает, что последняя ревизия не отображалась.
  const showStaleBadge =
    block.renderOk === false && block.renderedRevision !== null && block.renderedRevision !== pageRevision;

  return (
    <div className="bpmn-block">
      {/* Название диаграммы — HTML над схемой, вне SVG (задаётся write_diagram title). */}
      {block.title !== null && block.title !== '' && <div className="diagram-title">{block.title}</div>}
      <div className="bpmn-view-host" ref={hostRef}>
        <div className="bpmn-controls">
          <CopyButton text={block.source} title="Копировать исходник" className="bpmn-controls__btn" />
          {onExpand && <DiagramAction label="Во весь экран" icon={ArrowsExpand} onPress={onExpand} className="bpmn-controls__btn" />}
          <DiagramAction label="Скачать SVG" icon={ArrowDownToLine} onPress={downloadSvg} className="bpmn-controls__btn" />
          <DiagramAction label="Приблизить BPMN-схему" icon={MagnifierPlus} onPress={() => zoomBy(1.2)} className="bpmn-controls__btn" />
          <DiagramAction label="Отдалить BPMN-схему" icon={MagnifierMinus} onPress={() => zoomBy(0.8)} className="bpmn-controls__btn" />
          <DiagramAction label="Сбросить масштаб BPMN-схемы" icon={ArrowsExpand} onPress={zoomToFit} className="bpmn-controls__btn" />
          <Button variant="ghost" size="sm" aria-label="Скачать BPMN XML"
            onPress={() => {
              const filename = `${block.id}.bpmn`;
              void notifyDiagramDownload(filename, () => downloadTextFile(block.source, filename, 'application/xml'));
            }}>XML</Button>
        </div>
      </div>

      {error !== null && (
        <div className="bpmn-error" role="alert">
          <span className="bpmn-error__title">Отображается предыдущая версия схемы.</span>
          <span className="bpmn-error__detail"> Ошибка импорта BPMN: {error}</span>
        </div>
      )}
      {showStaleBadge && <div className="block__badge">Отображается предыдущая версия схемы</div>}
    </div>
  );
}
