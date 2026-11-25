import { useEffect } from 'react';
import { bindingFromEvent, sameBinding, shortcutIds } from './shortcuts';
import type { ShortcutId } from './shortcuts';
import { useShortcutBindings } from './shortcutPreferences';

const blockingOverlay = '[data-slot="modal-dialog"], [data-slot="drawer-dialog"], [role="alertdialog"], [aria-modal="true"]';

export function useShortcuts({ openSettings, goBack, goForward, toggleAgent }: Partial<Record<ShortcutId, (() => void) | undefined>>): void {
  const bindings = useShortcutBindings();
  useEffect(() => {
    const actions = { openSettings, goBack, goForward, toggleAgent };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const binding = bindingFromEvent(event);
      if (!binding) return;
      const id = shortcutIds.find(id => sameBinding(bindings[id], binding));
      const action = id && actions[id];
      if (!action) return;
      event.preventDefault();
      if (!event.repeat && !document.querySelector(blockingOverlay)) action();
    };

    // Перехватываем сочетание до редактора, в том числе в режиме Vim.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [bindings, openSettings, goBack, goForward, toggleAgent]);
}
