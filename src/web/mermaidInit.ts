/**
 * Общая инициализация Mermaid для всего веб-интерфейса — строго один раз за сессию страницы.
 * Тема: выбор пользователя из диалога настроек (localStorage), иначе флаг --theme сервера
 * (через /api/config), иначе default. Смена темы переинициализирует mermaid и уведомляет
 * подписчиков — отрисованные диаграммы перерисовываются.
 */
import { useSyncExternalStore } from 'react';
import mermaid from 'mermaid';
import { getConfig } from './api';
import { MERMAID_THEMES } from '../shared/types';
import type { MermaidTheme } from '../shared/types';

const STORAGE_THEME = 'livenote_mermaid_theme';

/**
 * Базовый конфиг mermaid для всех initialize. straightenEdges выключен: дефолт true
 * в mermaid 12.1.0 переносит лейблы рёбер на выпрямленный маршрут, и длинный лейбл
 * налезает на узлы и соседние рёбра; false возвращает раскладку mermaid-live-editor
 * (mermaid 12.0.0), геометрический паритет проверен 2026-10-07.
 */
const MERMAID_BASE_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  elk: { straightenEdges: false }
} as const;

let initialized = false;
let initPromise: Promise<void> | null = null;
/** Тема с сервера (флаг --theme) — фолбэк, когда пользовательская не задана. */
let serverTheme: MermaidTheme = 'default';
/** Действующая тема: пользовательская переопределённая или серверная. */
let activeTheme: MermaidTheme = 'default';
let themeVersion = 0;
const listeners = new Set<() => void>();

function loadOverride(): MermaidTheme | null {
  try {
    const raw = localStorage.getItem(STORAGE_THEME);
    return MERMAID_THEMES.includes(raw as MermaidTheme) ? (raw as MermaidTheme) : null;
  } catch {
    return null;
  }
}

/** Инициализирует mermaid один раз; повторные вызовы дожидаются того же промиса. */
export function ensureMermaidInitialized(): Promise<void> {
  if (initialized) {
    return Promise.resolve();
  }
  initPromise ??= (async () => {
    try {
      serverTheme = (await getConfig()).mermaidTheme;
    } catch {
      // Конфиг недоступен — рендерим с дефолтной темой, не блокируя интерфейс.
    }
    activeTheme = loadOverride() ?? serverTheme;
    mermaid.initialize({
      ...MERMAID_BASE_CONFIG,
      theme: activeTheme
    });
    initialized = true;
  })().catch((error: unknown) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

/** Выбор пользователя в настройках; null — следовать теме сервера. */
export function getThemeOverride(): MermaidTheme | null {
  return loadOverride();
}

export function getThemeVersion(): number {
  return themeVersion;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Смена темы пользователем: null — вернуться к теме сервера. Сохраняется в localStorage. */
export function setThemeOverride(theme: MermaidTheme | null): void {
  try {
    if (theme === null) {
      localStorage.removeItem(STORAGE_THEME);
    } else {
      localStorage.setItem(STORAGE_THEME, theme);
    }
  } catch {
    // localStorage недоступен — тема применится только до перезагрузки страницы.
  }
  const next = theme ?? serverTheme;
  if (next === activeTheme) {
    return;
  }
  activeTheme = next;
  themeVersion += 1;
  mermaid.initialize({
    ...MERMAID_BASE_CONFIG,
    theme: next
  });
  listeners.forEach((listener) => listener());
}

/** Версия темы для useSyncExternalStore: рост счётчика означает смену темы. */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribeTheme, getThemeVersion);
}
