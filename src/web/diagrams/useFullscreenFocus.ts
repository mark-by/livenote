import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

interface FullscreenFocusOptions {
  readonly close: () => void;
  readonly suspended: boolean;
  readonly saving: boolean;
  readonly save: () => void;
}

/** Локальный keyboard boundary не пропускает Vim и shortcuts в документ. */
export function useFullscreenFocus(options: FullscreenFocusOptions) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const recoverFocus = (event: globalThis.KeyboardEvent): void => {
      const root = closeRef.current?.closest('[role="dialog"]');
      if (event.key !== 'Tab' || !root || root.contains(document.activeElement)) return;
      const controls = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled)'))
        .filter((element) => element.getClientRects().length > 0);
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    };
    document.addEventListener('keydown', recoverFocus);
    return () => {
      document.removeEventListener('keydown', recoverFocus);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    event.stopPropagation();
    if (options.suspended) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!options.saving) options.save();
      return;
    }
    if (event.key === 'Escape' && !event.defaultPrevented && !options.saving) options.close();
    if (event.key !== 'Tab') return;
    const root = event.currentTarget;
    const controls = Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe'
    )).filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (!root.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  return { closeRef, onKeyDown };
}
