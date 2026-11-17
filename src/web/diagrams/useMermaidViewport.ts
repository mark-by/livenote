import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import mermaid from 'mermaid';
import { ensureMermaidInitialized, useThemeVersion } from '../mermaidInit';
import { staticSvgMarkup } from '../svgDownload';
import type { DiagramEditor } from '../components/useDiagramEditor';

interface MermaidViewportOptions {
  readonly blockId: string;
  readonly editor: DiagramEditor;
  readonly editorRef: RefObject<DiagramEditor>;
}

/** Прежний SVG render/pan fullscreen; inline viewer остаётся отдельным потребителем Mermaid. */
export function useMermaidViewport({ blockId, editor, editorRef }: MermaidViewportOptions) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef('');
  const idRef = useRef(0);
  const transform = useRef({ x: 0, y: 0, s: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderedSource, setRenderedSource] = useState<string | null>(null);
  const themeVersion = useThemeVersion();

  const apply = (): void => {
    const t = transform.current;
    if (canvasRef.current) canvasRef.current.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})`;
  };
  const zoomAt = (scale: number, point: { x: number; y: number }): void => {
    const t = transform.current;
    const next = Math.min(10, Math.max(0.1, scale));
    const ratio = next / t.s;
    t.x = point.x - (point.x - t.x) * ratio;
    t.y = point.y - (point.y - t.y) * ratio;
    t.s = next;
    apply();
  };
  const fit = (): void => {
    const svg = hostRef.current?.querySelector('svg');
    const area = canvasRef.current?.parentElement?.getBoundingClientRect();
    if (!svg || !area) return;
    const bounds = svg.getBoundingClientRect();
    const width = bounds.width / transform.current.s;
    const height = bounds.height / transform.current.s;
    if (width <= 0 || height <= 0 || area.width <= 0 || area.height <= 0) return;
    const scale = Math.min(area.width / width, area.height / height, 1);
    transform.current = { s: scale, x: (area.width - width * scale) / 2, y: (area.height - height * scale) / 2 };
    apply();
  };
  const zoom = (factor: number): void => {
    const area = canvasRef.current?.parentElement?.getBoundingClientRect();
    if (area) zoomAt(transform.current.s * factor, { x: area.width / 2, y: area.height / 2 });
  };

  useEffect(() => {
    const area = canvasRef.current?.parentElement;
    if (!area) return;
    const observer = new ResizeObserver(fit);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    let disposed = false;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const area = canvas.parentElement?.getBoundingClientRect();
      if (area) zoomAt(transform.current.s * (event.deltaY < 0 ? 1.15 : 1 / 1.15),
        { x: event.clientX - area.left, y: event.clientY - area.top });
    };
    const down = (event: PointerEvent): void => {
      if (editorRef.current.editing && event.target instanceof Element &&
        event.target.closest('.node, .flowchart-link, path.relation')) return;
      if (event.button !== 0) return;
      drag.current = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('diagram-fullscreen__canvas--dragging');
    };
    const move = (event: PointerEvent): void => {
      if (!drag.current) return;
      transform.current.x += event.clientX - drag.current.x;
      transform.current.y += event.clientY - drag.current.y;
      drag.current = { x: event.clientX, y: event.clientY };
      apply();
    };
    const up = (event: PointerEvent): void => {
      drag.current = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      canvas.classList.remove('diagram-fullscreen__canvas--dragging');
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    void (async () => {
      try {
        await ensureMermaidInitialized();
        if (disposed) return;
        await mermaid.parse(editor.source);
        if (disposed) return;
        const { svg } = await mermaid.render(`livenote-fs-${blockId}-${++idRef.current}`, editor.source);
        if (disposed) return;
        host.innerHTML = svg;
        editorRef.current.decorate(host);
        svgRef.current = staticSvgMarkup(svg);
        setRenderedSource(editor.source);
        setError(null);
        fit();
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => {
      disposed = true;
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
  }, [blockId, editor.source, themeVersion]);

  useEffect(() => {
    if (hostRef.current) editor.decorate(hostRef.current);
  }, [editor.selection, editor.editing]);
  return { canvasRef, hostRef, svgRef, renderedSource, error, setError, fit, zoom };
}
