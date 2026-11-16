/**
 * Модальное окно настроек интерфейса: тема mermaid, ширина страницы,
 * «Следовать за изменениями». Открывается кнопкой-шестерёнкой в тулбаре;
 * настройки живут в App (ширина, следование) и в mermaidInit (тема).
 */import { useEffect, useRef, useState } from 'react';
import { MERMAID_THEMES } from '../../shared/types';
import type { MermaidTheme } from '../../shared/types';
import { getThemeOverride, setThemeOverride } from '../mermaidInit';

/** Варианты ширины страницы. */
export type PageWidth = 'standard' | 'wide' | 'full';

export const PAGE_WIDTHS: Array<{ value: PageWidth; label: string }> = [
  { value: 'standard', label: 'Обычная' },
  { value: 'wide', label: 'Широкая' },
  { value: 'full', label: 'На всю' }
];

const THEME_OPTIONS: Array<{ value: MermaidTheme | ''; label: string }> = [
  { value: '', label: 'Как на сервере' },
  ...MERMAID_THEMES.map((theme) => ({ value: theme, label: theme }))
];

interface SettingsDialogProps {
  pageWidth: PageWidth;
  onPageWidthChange(width: PageWidth): void;
  followEvents: boolean;
  onFollowChange(follow: boolean): void;
  onClose(): void;
}

export function SettingsDialog({
  pageWidth,
  onPageWidthChange,
  followEvents,
  onFollowChange,
  onClose
}: SettingsDialogProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useState<string>(() => getThemeOverride() ?? '');

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Настройки">
      <div className="modal">
        <h2 className="modal__title">Настройки</h2>
        <label className="settings__row">
          <span>Тема mermaid</span>
          <select
            className="toolbar__select"
            value={theme}
            onChange={(event) => {
              const value = event.target.value;
              setTheme(value);
              setThemeOverride(value === '' ? null : (value as MermaidTheme));
            }}
          >
            {THEME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="settings__row">
          <span>Ширина страницы</span>
          <select
            className="toolbar__select"
            value={pageWidth}
            onChange={(event) => onPageWidthChange(event.target.value as PageWidth)}
          >
            {PAGE_WIDTHS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="settings__row settings__row--check">
          <input
            type="checkbox"
            checked={followEvents}
            onChange={(event) => onFollowChange(event.target.checked)}
          />
          <span>Следовать за изменениями</span>
        </label>
        <div className="modal__actions">
          <button ref={closeRef} className="btn btn--primary" type="button" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}
