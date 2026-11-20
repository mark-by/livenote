import { useRef } from 'react';
import type { CSSProperties } from 'react';
import { MAX_SPLIT_PERCENT, MIN_SPLIT_PERCENT } from './vaultPaneState';
import type { PositionedSplit } from './vaultPaneState';

const keyboardStep = 5;

export function VaultPaneDivider({ split, resize }: {
  readonly split: PositionedSplit;
  readonly resize: (id: number, percent: number) => void;
}): React.JSX.Element {
  const { id, direction, percent, x, y, width, height } = split;
  const vertical = direction === 'right';
  const style: CSSProperties = vertical
    ? { left: `${x + width * percent / 100}%`, top: `${y}%`, height: `${height}%` }
    : { left: `${x}%`, top: `${y + height * percent / 100}%`, width: `${width}%` };
  const drag = useRef<{
    readonly pointerId: number;
    readonly start: number;
    readonly percent: number;
    readonly extent: number;
  } | null>(null);

  return <div className="vault-pane-divider" style={style} role="separator" tabIndex={0}
    aria-orientation={vertical ? 'vertical' : 'horizontal'}
    aria-label={vertical ? 'Ширина панелей редактора' : 'Высота панелей редактора'}
    aria-valuemin={MIN_SPLIT_PERCENT} aria-valuemax={MAX_SPLIT_PERCENT} aria-valuenow={Math.round(percent)}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      const area = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!area) return;
      const extent = vertical ? area.width * width / 100 : area.height * height / 100;
      if (extent <= 0) return;
      // Без preventDefault WebKit может выделить текст даже после захвата указателя.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
      drag.current = { pointerId: event.pointerId, start: vertical ? event.clientX : event.clientY, percent, extent };
    }}
    onPointerMove={event => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const coordinate = vertical ? event.clientX : event.clientY;
      const nextPercent = active.percent + (coordinate - active.start) / active.extent * 100;
      resize(id, nextPercent);
    }}
    onLostPointerCapture={event => {
      if (drag.current?.pointerId === event.pointerId) drag.current = null;
    }}
    onKeyDown={event => {
      if (drag.current) return;
      let next: number;
      switch (event.key) {
        case vertical ? 'ArrowLeft' : 'ArrowUp': next = percent - keyboardStep; break;
        case vertical ? 'ArrowRight' : 'ArrowDown': next = percent + keyboardStep; break;
        case 'Home': next = MIN_SPLIT_PERCENT; break;
        case 'End': next = MAX_SPLIT_PERCENT; break;
        default: return;
      }
      event.preventDefault();
      resize(id, next);
    }}
  />;
}
