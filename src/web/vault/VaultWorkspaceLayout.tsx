import { useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Surface } from '@heroui/react';
import { AGENT_DEFAULT_WIDTH, AGENT_MAX_WIDTH, AGENT_MIN_WIDTH, AGENT_RESIZE_STEP, clampAgentWidth } from '../agent/agentStorage';

const widthKey = 'livenote_sidebar_width';
const defaultWidth = 264;
const minWidth = 200;
const maxWidth = 480;
const keyboardStep = 16;

function clampWidth(width: number): number {
  return Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
}

export function VaultWorkspaceLayout({ sidebar, children, agentPanel, agentPanelOpen = false, agentPanelWidth = AGENT_DEFAULT_WIDTH, onAgentPanelWidthChange }: {
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
  readonly agentPanel?: ReactNode;
  readonly agentPanelOpen?: boolean;
  readonly agentPanelWidth?: number;
  readonly onAgentPanelWidthChange?: (width: number) => void;
}): React.JSX.Element {
  const sidebarId = useId();
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(widthKey));
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : defaultWidth;
  });
  const drag = useRef<{ readonly pointerId: number; readonly startX: number; readonly startWidth: number; width: number } | null>(null);
  const style: CSSProperties & { '--vault-sidebar-width': string; '--agent-panel-width': string } = {
    '--vault-sidebar-width': `${width}px`, '--agent-panel-width': `${agentPanelWidth}px`
  };
  const agentDrag = useRef<{ readonly pointerId: number; readonly startX: number; readonly startWidth: number; width: number } | null>(null);
  const agentPanelId = useId();
  const resizeAgent = (next: number): void => {
    const resized = clampAgentWidth(next);
    onAgentPanelWidthChange?.(resized);
    if (agentDrag.current) agentDrag.current.width = resized;
  };

  return <div className="vault-workspace relative" style={style} data-agent-open={agentPanel !== undefined && agentPanelOpen ? 'true' : undefined}>
    <Surface id={sidebarId} className="vault-sidebar" variant="default">{sidebar}</Surface>
    <div className="vault-sidebar-resizer" role="separator" tabIndex={0}
      aria-label="Ширина дерева заметок" aria-controls={sidebarId} aria-orientation="vertical"
      aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={width} aria-valuetext={`${width} пикселей`}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        // Без отмены WebKit выделяет текст поверх захвата указателя.
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
      }}
      onPointerMove={event => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        active.width = clampWidth(active.startWidth + event.clientX - active.startX);
        setWidth(active.width);
      }}
      onLostPointerCapture={event => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        drag.current = null;
        localStorage.setItem(widthKey, String(active.width));
      }}
      onKeyDown={event => {
        if (drag.current) return;
        let next: number;
        switch (event.key) {
          case 'ArrowLeft': next = width - keyboardStep; break;
          case 'ArrowRight': next = width + keyboardStep; break;
          case 'Home': next = minWidth; break;
          case 'End': next = maxWidth; break;
          default: return;
        }
        event.preventDefault();
        const resized = clampWidth(next);
        setWidth(resized);
        localStorage.setItem(widthKey, String(resized));
      }}
    />
    {children}
    {agentPanel !== undefined && <>
      <div className="agent-resizer" role="separator" tabIndex={agentPanelOpen ? 0 : -1} hidden={!agentPanelOpen}
        aria-label="Ширина чата агента" aria-controls={agentPanelId} aria-orientation="vertical"
        aria-valuemin={AGENT_MIN_WIDTH} aria-valuemax={AGENT_MAX_WIDTH} aria-valuenow={agentPanelWidth} aria-valuetext={`${agentPanelWidth} пикселей`}
        onPointerDown={event => {
          if (event.button !== 0 || agentDrag.current) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus({ preventScroll: true });
          agentDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: agentPanelWidth, width: agentPanelWidth };
        }}
        onPointerMove={event => {
          const active = agentDrag.current;
          if (!active || active.pointerId !== event.pointerId) return;
          resizeAgent(active.startWidth + active.startX - event.clientX);
        }}
        onLostPointerCapture={event => {
          if (agentDrag.current?.pointerId === event.pointerId) agentDrag.current = null;
        }}
        onKeyDown={event => {
          if (agentDrag.current) return;
          let next: number;
          switch (event.key) {
            case 'ArrowLeft': next = agentPanelWidth + AGENT_RESIZE_STEP; break;
            case 'ArrowRight': next = agentPanelWidth - AGENT_RESIZE_STEP; break;
            case 'Home': next = AGENT_MIN_WIDTH; break;
            case 'End': next = AGENT_MAX_WIDTH; break;
            default: return;
          }
          event.preventDefault();
          resizeAgent(next);
        }}
      />
      <div id={agentPanelId} className="agent-panel-host max-[50rem]:absolute max-[50rem]:inset-x-0 max-[50rem]:top-0 max-[50rem]:bottom-10 max-[50rem]:z-2" hidden={!agentPanelOpen}>{agentPanel}</div>
    </>}
  </div>;
}
