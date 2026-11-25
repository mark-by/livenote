import { useEffect, useState } from 'react';
import { Button, Kbd, Surface } from '@heroui/react';
import { resetShortcuts, saveShortcut, useShortcutBindings } from '../shortcutPreferences';
import { bindingFromEvent, shortcutKey, shortcutModifier, shortcuts } from '../shortcuts';
import type { ShortcutId } from '../shortcuts';

export function HotkeySettings({ shortcuts: ids }: {
  readonly shortcuts: readonly ShortcutId[];
}): React.JSX.Element {
  const bindings = useShortcutBindings();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modifier = shortcutModifier();
  const modifierLabel = modifier === 'command' ? '⌘' : 'Ctrl';
  useEffect(() => {
    if (recording === null) return;
    const capture = (event: KeyboardEvent): void => {
      if (event.key === 'Tab' || event.isComposing || ['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return;
      // Escape отменяет запись, а не закрывает окно настроек.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        setError(null);
        return;
      }
      if (event.repeat) return;
      const binding = bindingFromEvent(event);
      const failure = binding ? saveShortcut(recording, binding) : `Нажмите ${modifierLabel} вместе с другой клавишей.`;
      setError(failure);
      if (failure === null) setRecording(null);
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [recording, modifierLabel]);

  return <div className="grid gap-4">
    <p className="text-sm text-muted">Выберите сочетание и нажмите новые клавиши. Изменения сохраняются сразу.</p>
    <Surface variant="secondary" className="rounded-2xl">
      <ul role="list" className="divide-y divide-separator-secondary">
        {ids.map(id => {
          const { label } = shortcuts[id];
          const binding = bindings[id];
          const active = recording === id;
          return <li key={id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3">
            <span className="min-w-0 flex-1 text-base font-semibold text-foreground">{label}</span>
            <Button size="sm" variant={active ? 'secondary' : 'ghost'} className="min-h-11 shrink-0 min-[50rem]:min-h-9"
              aria-pressed={active} aria-label={`Изменить сочетание: ${label}`}
              onBlur={() => {
                if (active) { setRecording(null); setError(null); }
              }}
              onPress={() => {
                setError(null);
                setRecording(active ? null : id);
              }}>
              <Kbd><Kbd.Abbr keyValue={modifier} />
                {binding.alt && <Kbd.Abbr keyValue={modifier === 'command' ? 'option' : 'alt'} />}
                {binding.shift && <Kbd.Abbr keyValue="shift" />}
                <Kbd.Content>{shortcutKey(binding.code)}</Kbd.Content>
              </Kbd>
            </Button>
          </li>;
        })}
      </ul>
    </Surface>
    {recording !== null && <p role="status" className="text-sm text-muted">Нажмите новое сочетание для действия «{shortcuts[recording].label}». Esc отменяет запись.</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <Button size="sm" variant="secondary" className="min-h-11 justify-self-start min-[50rem]:min-h-9" onPress={() => {
      setRecording(null);
      setError(resetShortcuts());
    }}>Восстановить по умолчанию</Button>
  </div>;
}
