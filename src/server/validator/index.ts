/**
 * Фабрика валидатора диаграмм LiveNote.
 * Пытается поднять playwright-валидатор (headless Chromium + mermaid как в UI);
 * любая ошибка окружения (нет пакета playwright, не установлен браузер, нет бандла
 * mermaid) даёт UnavailableValidator — фабрика никогда не бросает исключение наружу.
 */
import type { DiagramValidation, DiagramValidator, MermaidTheme } from '../../shared/types.js';
import { PlaywrightValidator, UNAVAILABLE, createPlaywrightValidator } from './playwright.js';

/** Заглушка валидатора: синтаксис не проверяется, рендер недоступен. */
class UnavailableValidator implements DiagramValidator {
  readonly kind = 'unavailable' as const;

  parse(): Promise<DiagramValidation> {
    return Promise.resolve(UNAVAILABLE);
  }

  render(): Promise<{ validation: DiagramValidation }> {
    return Promise.resolve({ validation: UNAVAILABLE });
  }
}

/** Фабрика валидатора: playwright при доступности окружения, иначе честная деградация. */
export async function createValidator(mermaidTheme: MermaidTheme): Promise<DiagramValidator> {
  try {
    return await createPlaywrightValidator(mermaidTheme);
  } catch (error) {
    // Браузеры playwright не установлены или пакет недоступен — работаем без проверки диаграмм.
    console.error(
      '[livenote] проверка диаграмм недоступна (playwright-валидатор не поднялся):',
      error instanceof Error ? error.message : error
    );
    return new UnavailableValidator();
  }
}
