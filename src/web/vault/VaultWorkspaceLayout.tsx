import { useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Surface } from '@heroui/react';

const widthKey = 'livenote_sidebar_width';
const defaultWidth = 264;
const minWidth = 200;
const maxWidth = 480;
const keyboardStep = 16;

function clampWidth(width: number): number {
  return Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
}

export function VaultWorkspaceLayout({ sidebar, children }: {
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  const sidebarId = useId();
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(widthKey));
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : defaultWidth;
  });
  const drag = useRef<{ readonly pointerId: number; readonly startX: number; readonly startWidth: number; width: number } | null>(null);
  const style: CSSProperties & { '--vault-sidebar-width': string } = { '--vault-sidebar-width': `${width}px` };

  return <div className="vault-workspace" style={style}>
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
  </div>;
}
