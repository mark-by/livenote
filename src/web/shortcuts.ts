export const shortcuts = {
  goBack: { code: 'BracketLeft', label: 'Назад по истории файлов', terms: 'jump back предыдущий файл' },
  goForward: { code: 'BracketRight', label: 'Вперёд по истории файлов', terms: 'jump forward следующий файл' },
  toggleAgent: { code: 'KeyP', label: 'Открыть или закрыть панель агента', terms: 'open close agent panel чат' },
  openSettings: { code: 'Comma', label: 'Открыть настройки', terms: 'open settings' }
} as const;

export type ShortcutId = keyof typeof shortcuts;
export const shortcutIds = Object.keys(shortcuts) as ShortcutId[];

export interface ShortcutBinding {
  readonly code: string;
  readonly shift: boolean;
  readonly alt: boolean;
}

export function shortcutModifier(): 'command' | 'ctrl' {
  return /Mac/i.test(navigator.platform) ? 'command' : 'ctrl';
}

const specialKeys: Readonly<Partial<Record<string, string>>> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→'
};

export function shortcutKey(code: string): string | undefined {
  if (/^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2]))$/.test(code)) return code.replace(/^(Key|Digit)/, '');
  return Object.prototype.hasOwnProperty.call(specialKeys, code) ? specialKeys[code] : undefined;
}

export function bindingFromEvent(event: KeyboardEvent): ShortcutBinding | null {
  const primary = shortcutModifier() === 'command'
    ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.isComposing || event.getModifierState('AltGraph') || !shortcutKey(event.code)) return null;
  return { code: event.code, shift: event.shiftKey, alt: event.altKey };
}

export function sameBinding(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return a.code === b.code && a.shift === b.shift && a.alt === b.alt;
}
