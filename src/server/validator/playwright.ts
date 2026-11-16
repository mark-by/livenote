/**
 * Валидатор Mermaid на Playwright: headless Chromium + UMD-бандл mermaid из node_modules —
 * окружение ровно как в веб-интерфейсе (securityLevel strict, theme default).
 * Браузер и страница — ленивый синглтон: создаются при первом обращении (не в конструкторе),
 * переиспользуются и восстанавливаются после сбоя (одна повторная попытка на операцию).
 * Ошибки mermaid (синтаксис) отдаются структурой, ошибки окружения — исключением,
 * которое гасит фабрика createValidator в index.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Browser, Page } from 'playwright';
import type { DiagramRenderResult, DiagramValidation, DiagramValidator, MermaidTheme } from '../../shared/types.js';

/** Таймаут всех операций в браузере: зависший рендер не подвесит инструмент. */
const OPERATION_TIMEOUT_MS = 15_000;
/** Лимит кеша результатов; при переполнении вытесняется первая вставленная запись. */
const CACHE_LIMIT = 200;
/** Базовый HTML страницы, в которую подгружается mermaid. */
const BASE_HTML = '<!doctype html><html><body><div id="container"></div></body></html>';

/** Константа «проверка не выполнялась»: инфраструктура валидации недоступна. */
export const UNAVAILABLE: DiagramValidation = Object.freeze({ syntax: 'not_checked', renderer: 'unavailable' });

/** Итог render(): валидация плюс опциональный результат отрисовки. */
interface RenderOutcome {
  validation: DiagramValidation;
  render?: DiagramRenderResult;
}

/** Ответ mermaid.parse из браузера. */
interface BrowserParseOutcome {
  ok: boolean;
  diagramType?: string;
  message?: string;
  line?: number;
}

/** Ответ mermaid.render из браузера. */
interface BrowserRenderOutcome {
  svg: string;
  width?: number;
  height?: number;
}

/** UMD-глобал mermaid в браузере — минимальный контракт, достаточный валидатору. */
interface BrowserMermaid {
  initialize(config: {
    startOnLoad: boolean;
    securityLevel: string;
    theme: string;
    suppressErrorRendering: boolean;
    elk: { straightenEdges: boolean };
  }): void;
  parse(text: string, options: { suppressErrors: boolean }): Promise<unknown>;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/** Минимальное DOM-окружение внутри evaluate (lib проекта без DOM). */
interface BrowserDocument {
  createElement(tagName: string): {
    innerHTML: string;
    querySelector(selectors: string): { getAttribute(name: string): string | null } | null;
  };
}

/** Кеш с лимитом записей: при переполнении вытесняется самая старая. */
class BoundedCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly limit: number) {}

  get(key: string): T | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T): void {
    // Повторная запись подвигает ключ в конец: свежие записи вытесняются последними.
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}

/** sha256-ключ кеша из частей, склеенных через '|'. */
function sha256(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Ограничить промис таймаутом: зависший на кривой диаграмме Chromium не подвесит вызов. */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Таймаут операции "${label}" (${OPERATION_TIMEOUT_MS} мс)`)), OPERATION_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Реализация DiagramValidator на Playwright. Все операции сериализуются: страница одна,
 * и временный setContent перед скриншотом не должен пересекаться с evaluate другого вызова.
 */
export class PlaywrightValidator implements DiagramValidator {
  readonly kind = 'playwright' as const;

  private chromium?: typeof import('playwright').chromium;
  private browser?: Browser;
  private page?: Page;
  /** Тема mermaid из конфига сервера — применяется в initialize при подготовке страницы. */
  private readonly mermaidTheme: MermaidTheme;
  private readonly parseCache = new BoundedCache<DiagramValidation>(CACHE_LIMIT);
  private readonly renderCache = new BoundedCache<RenderOutcome>(CACHE_LIMIT);
  /** Очередь, гарантирующая поочерёдный доступ к единственной странице. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(mermaidTheme: MermaidTheme) {
    this.mermaidTheme = mermaidTheme;
  }

  async parse(source: string): Promise<DiagramValidation> {
    return this.exclusive(async () => {
      const key = sha256(['parse', source]);
      const cached = this.parseCache.get(key);
      if (cached !== undefined) return cached;
      const validation = await this.parseViaBrowser(source);
      this.parseCache.set(key, validation);
      return validation;
    }).catch(() => UNAVAILABLE);
  }

  async render(source: string, options?: { includeImage?: boolean }): Promise<RenderOutcome> {
    const includeImage = options?.includeImage === true;
    return this.exclusive(async () => {
      const key = sha256(['render', source, includeImage ? 'png' : 'svg']);
      const cached = this.renderCache.get(key);
      if (cached !== undefined) return cached;
      try {
        const validation = await this.parseViaBrowser(source);
        if (validation.syntax !== 'ok') {
          // Синтаксическая ошибка — рендер не выполняется, это нормальный ответ.
          const failed: RenderOutcome = { validation };
          this.renderCache.set(key, failed);
          return failed;
        }
        const outcome = await this.renderViaBrowser(source, includeImage, validation);
        this.renderCache.set(key, outcome);
        return outcome;
      } catch {
        // Две неудачные попытки — окружение недоступно, честный unavailable.
        return { validation: UNAVAILABLE };
      }
    });
  }

  /** Первичная инициализация: фабрика вызывает сразу, чтобы уметь честно деградировать. */
  async warmUp(): Promise<void> {
    await this.exclusive(() => this.attempt('init', () => this.ensurePage().then(() => undefined)));
  }

  /** parse через браузер; инфраструктурный сбой после повтора выбрасывается наружу. */
  private async parseViaBrowser(source: string): Promise<DiagramValidation> {
    const raw = await this.attempt('parse', (page) => this.evaluateParse(page, source));
    if (raw.ok) {
      return { syntax: 'ok', renderer: 'playwright', ...(raw.diagramType !== undefined ? { diagramType: raw.diagramType } : {}) };
    }
    return {
      syntax: 'error',
      renderer: 'playwright',
      error: { message: raw.message ?? 'Неизвестная ошибка Mermaid', ...(raw.line !== undefined ? { line: raw.line } : {}) }
    };
  }

  /** render через браузер; PNG некритичен — при сбое скриншота отдаём результат без него. */
  private async renderViaBrowser(source: string, includeImage: boolean, validation: DiagramValidation): Promise<RenderOutcome> {
    const drawn = await this.attempt('render', (page) => this.evaluateRender(page, source));
    const pngBase64 = includeImage
      ? await this.attempt('screenshot', (page) => this.screenshot(page, drawn.svg)).catch(() => undefined)
      : undefined;
    return {
      validation,
      render: {
        svg: drawn.svg,
        ...(drawn.width !== undefined ? { width: drawn.width } : {}),
        ...(drawn.height !== undefined ? { height: drawn.height } : {}),
        ...(pngBase64 !== undefined ? { pngBase64 } : {})
      }
    };
  }

  /** Одна попытка; при сбое — закрыть страницу, пересоздать окружение и повторить ровно один раз. */
  private async attempt<T>(label: string, task: (page: Page) => Promise<T>): Promise<T> {
    try {
      // Таймаут накрывает и подготовку страницы, и саму операцию.
      return await withTimeout(task(await this.ensurePage()), label);
    } catch (firstError) {
      const reason = firstError instanceof Error ? firstError.message : firstError;
      console.error(`[livenote] playwright-валидатор: "${label}" не удалась, пересоздаю окружение:`, reason);
      await this.page?.close().catch(() => undefined);
      this.page = undefined;
      return withTimeout(task(await this.ensurePage()), label);
    }
  }

  /**
   * Ленивый синглтон страницы: живая страница с загруженным mermaid. Браузер и страница
   * создаются при первом вызове и пересоздаются при потере (page.isClosed, отключение
   * браузера, отсутствие глобала mermaid — например после setContent для скриншота).
   */
  private async ensurePage(): Promise<Page> {
    const existing = this.page;
    if (existing !== undefined && !existing.isClosed() && (await this.hasMermaid(existing))) {
      return existing;
    }
    if (this.browser === undefined || !this.browser.isConnected()) {
      if (this.browser !== undefined) await this.browser.close().catch(() => undefined);
      // launch падает, если браузер не установлен, — исключение идёт фабрике.
      const chromium = this.chromium ?? (await import('playwright')).chromium;
      this.chromium = chromium;
      this.browser = await chromium.launch({ headless: true });
    }
    const page = existing !== undefined && !existing.isClosed() ? existing : await this.browser.newPage();
    page.setDefaultTimeout(OPERATION_TIMEOUT_MS);
    this.page = page;
    await this.prepareEnvironment(page);
    return page;
  }

  /** Окружение страницы: UMD-бандл mermaid + initialize ровно как в UI. */
  private async prepareEnvironment(page: Page): Promise<void> {
    const path = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js');
    if (!existsSync(path)) throw new Error(`UMD-бандл mermaid не найден: ${path}`);
    await page.setContent(BASE_HTML);
    await page.addScriptTag({ path });
    await page.evaluate(() => {
      const mermaid = (globalThis as { mermaid?: BrowserMermaid }).mermaid;
      if (mermaid === undefined) throw new Error('UMD-скрипт mermaid не определил глобал');
      // suppressErrorRendering — опция конфига (третий аргумент render — это контейнер,
      // а не опции): при ошибке mermaid кидает исключение и не рисует error-svg.
      // straightenEdges: false — лейблы рёбер не переносятся на выпрямленный маршрут и
      // не налезают на узлы; раскладка совпадает с mermaid-live-editor (12.0.0).
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: this.mermaidTheme,
        suppressErrorRendering: true,
        elk: { straightenEdges: false }
      });
    });
  }

  /** Проверка, что глобал mermaid доступен (после setContent для скриншота его нет). */
  private async hasMermaid(page: Page): Promise<boolean> {
    try {
      return await withTimeout(
        page.evaluate(() => typeof (globalThis as { mermaid?: unknown }).mermaid !== 'undefined'),
        'проверка mermaid'
      );
    } catch {
      return false;
    }
  }

  /** mermaid.parse в браузере; ошибки mermaid отдаются структурированным результатом. */
  private evaluateParse(page: Page, source: string): Promise<BrowserParseOutcome> {
    return page.evaluate(async (src): Promise<BrowserParseOutcome> => {
      try {
        const mermaid = (globalThis as { mermaid?: BrowserMermaid }).mermaid;
        if (mermaid === undefined) return { ok: false, message: 'mermaid не загружен в странице' };
        const result: unknown = await mermaid.parse(src, { suppressErrors: false });
        const diagramType =
          result !== null && typeof result === 'object' ? (result as { diagramType?: unknown }).diagramType : undefined;
        return { ok: true, ...(typeof diagramType === 'string' ? { diagramType } : {}) };
      } catch (error) {
        const line = (error as { hash?: { loc?: { start_line?: unknown } } }).hash?.loc?.start_line;
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          ...(typeof line === 'number' ? { line } : {})
        };
      }    }, source);
  }

  /** mermaid.render в браузере + числовые размеры svg (атрибуты width/height, иначе viewBox). */
  private evaluateRender(page: Page, source: string): Promise<BrowserRenderOutcome> {
    return page.evaluate(async (src): Promise<BrowserRenderOutcome> => {
      const mermaid = (globalThis as { mermaid?: BrowserMermaid }).mermaid;
      if (mermaid === undefined) throw new Error('mermaid не загружен в странице');
      const { svg } = await mermaid.render('livenote-' + Math.random().toString(36).slice(2), src);
      const doc = (globalThis as { document?: BrowserDocument }).document;
      if (doc === undefined) throw new Error('DOM недоступен в странице');
      // Размеры ищем в отдельном элементе: атрибуты ("100", "100px"), иначе значения viewBox.
      const probe = doc.createElement('div');
      probe.innerHTML = svg;
      const svgEl = probe.querySelector('svg');
      const size = (attr: string | null | undefined): number | undefined => {
        const match = attr === null || attr === undefined ? null : /^\s*([\d.]+)\s*(?:px|pt)?\s*$/i.exec(attr);
        return match === null ? undefined : Number(match[1]);
      };
      let width = size(svgEl?.getAttribute('width'));
      let height = size(svgEl?.getAttribute('height'));
      const viewBox = svgEl?.getAttribute('viewBox');
      if (viewBox != null && (width === undefined || height === undefined)) {
        const [, , vx, vy] = viewBox.trim().split(/[\s,]+/);
        if (width === undefined) width = Number(vx) || undefined;
        if (height === undefined) height = Number(vy) || undefined;
      }
      return { svg, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
    }, source);
  }

  /** PNG-скриншот отрисованного svg: страница временно содержит только svg. */
  private async screenshot(page: Page, svg: string): Promise<string> {
    await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
    // omitBackground: тело страницы прозрачное по умолчанию — PNG без фона.
    const png = await page.locator('svg').first().screenshot({ type: 'png', omitBackground: true });
    return png.toString('base64');
  }

  /** Последовательный доступ к единственной странице: операции не должны пересекаться. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

/**
 * Фабрика playwright-валидатора. Сразу инициализирует окружение (import playwright,
 * resolve бандла, launch chromium): любая неудача выбрасывается, чтобы createValidator
 * в index.ts мог честно вернуть UnavailableValidator.
 */
export async function createPlaywrightValidator(mermaidTheme: MermaidTheme): Promise<DiagramValidator> {
  const validator = new PlaywrightValidator(mermaidTheme);
  await validator.warmUp();
  return validator;
}
