import { useMemo, useSyncExternalStore } from 'react';
import { sameBinding, shortcutIds, shortcutKey, shortcuts } from './shortcuts';
import type { ShortcutBinding, ShortcutId } from './shortcuts';

const storageKey = 'livenote_shortcuts';
const changeEvent = 'livenote:shortcuts-changed';
type Bindings = Readonly<Record<ShortcutId, ShortcutBinding>>;

function read(): string | null {
  try { return localStorage.getItem(storageKey); } catch { return null; }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === storageKey || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(changeEvent, listener);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(changeEvent, listener);
  };
}

function isBinding(value: unknown): value is ShortcutBinding {
  return typeof value === 'object' && value !== null &&
    'code' in value && typeof value.code === 'string' && shortcutKey(value.code) !== undefined &&
    'shift' in value && typeof value.shift === 'boolean' && 'alt' in value && typeof value.alt === 'boolean';
}

function defaultBindings(): Bindings {
  return {
    goBack: { code: shortcuts.goBack.code, shift: false, alt: false },
    goForward: { code: shortcuts.goForward.code, shift: false, alt: false },
    toggleAgent: { code: shortcuts.toggleAgent.code, shift: false, alt: false },
    openSettings: { code: shortcuts.openSettings.code, shift: false, alt: false }
  };
}

function decode(raw: string | null): Bindings {
  const defaults = defaultBindings();
  try {
    const saved: unknown = JSON.parse(raw ?? 'null');
    if (typeof saved !== 'object' || saved === null) return defaults;
    const bindings = { ...defaults };
    const values: Record<string, unknown> = { ...saved };
    for (const id of shortcutIds) {
      const value = values[id];
      if (isBinding(value)) bindings[id] = value;
    }
    return shortcutIds.some((id, index) =>
      shortcutIds.slice(index + 1).some(other => sameBinding(bindings[id], bindings[other]))
    ) ? defaults : bindings;
  } catch { return defaults; }
}

export function useShortcutBindings(): Bindings {
  const raw = useSyncExternalStore(subscribe, read);
  return useMemo(() => decode(raw), [raw]);
}

export function saveShortcut(id: ShortcutId, binding: ShortcutBinding): string | null {
  const current = decode(read());
  const conflict = shortcutIds.find(other => other !== id && sameBinding(current[other], binding));
  if (conflict) return `Сочетание уже назначено: ${shortcuts[conflict].label}.`;
  return persist({ ...current, [id]: binding });
}

export function resetShortcuts(): string | null {
  return persist(null);
}

function persist(bindings: Bindings | null): string | null {
  try {
    if (bindings) localStorage.setItem(storageKey, JSON.stringify(bindings));
    else localStorage.removeItem(storageKey);
  } catch {
    return 'Не удалось сохранить сочетания.';
  }
  window.dispatchEvent(new Event(changeEvent));
  return null;
}
