/**
 * Серверный BPMN-валидатор: разбор XML (bpmn-moddle), замечания bpmnlint,
 * рендер (bpmn-js в headless Chromium) и автораскладка (bpmn-auto-layout).
 * parse и layout — чистый Node и не зависят от браузера; render использует
 * ленивую страницу Chromium с восстановлением после сбоя (одна повторная
 * попытка на операцию). Публичные методы не бросают — только честная деградация.
 *
 * allow: SIZE_OK — файл самодостаточен по задаче: интерфейс, фабрика, обе
 * реализации и хелперы живут здесь, без импортов из playwright.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Browser, Page } from 'playwright';
import type { BpmnLintIssue, DiagramRenderResult, DiagramValidation, RendererKind } from '../../shared/types.js';
import { layoutProcess } from 'bpmn-auto-layout';
import { BpmnModdle } from 'bpmn-moddle';
import type { BpmnModdleRootElement } from 'bpmn-moddle';
import linterModule from 'bpmnlint/lib/linter.js';
import NodeResolver from 'bpmnlint/lib/resolver/node-resolver.js';

/** Таймаут операций в браузере: зависший рендер не подвесит инструмент. */
const OPERATION_TIMEOUT_MS = 15_000;
/** Лимит кешей результатов; при переполнении вытесняется первая вставленная запись. */
const CACHE_LIMIT = 200;
/** Размер страницы браузера: определяет SVG и PNG-скриншот. */
const VIEWPORT = { width: 1024, height: 768 } as const;
/** Базовый HTML страницы с контейнером bpmn-js явного размера. */
const BASE_HTML =
  '<!doctype html><html><head><style>#canvas{width:100vw;height:100vh}</style></head><body><div id="canvas"></div></body></html>';
/** Ключевые правила bpmnlint, реально присутствующие в пакете. */
const LINT_RULES = [
  'end-event-required',
  'no-disconnected',
  'no-duplicate-sequence-flows',
  'label-required',
  'conditional-flows',
  'no-gateway-join-fork',
  'event-based-gateway'
] as const;
/** Единая серьёзность lint-замечаний: они не блокируют публикацию. */
const LINT_SEVERITY = 'warn';

/** Валидация «проверка не выполнялась» — для render при недоступном Chromium. */
const NOT_CHECKED: DiagramValidation = Object.freeze({ syntax: 'not_checked', renderer: 'unavailable' });

/** Порт BPMN-валидатора: проверка, рендер и автораскладка. */
export interface BpmnValidator {
  readonly kind: RendererKind;
  parse(source: string): Promise<DiagramValidation>;
  render(
    source: string,
    options?: { includeImage?: boolean }
  ): Promise<{ validation: DiagramValidation; render?: DiagramRenderResult }>;
  layout(source: string): Promise<{ ok: boolean; xml?: string; error?: string }>;
}

/** Итог layout(). */
interface LayoutOutcome {
  ok: boolean;
  xml?: string;
  error?: string;
}

/** Итог render(). */
type RenderOutcome = { validation: DiagramValidation; render?: DiagramRenderResult };

/** Ответ bpmn-js из браузера. */
interface BrowserRenderOutcome {
  ok: boolean;
  message?: string;
  svg?: string;
  width?: number;
  height?: number;
  /** Число некритичных предупреждений importXML. */
  warnings?: number;
}

/** UMD-глобал bpmn-js — минимальный контракт, достаточный валидатору. */
interface BrowserViewer {
  importXML(xml: string): Promise<{ warnings: unknown[] }>;
  get(service: 'canvas'): { zoom(value: string): unknown };
  destroy(): void;
}

/** Минимальное DOM-окружение внутри evaluate (lib проекта без DOM). */
interface BrowserDocument {
  getElementById(id: string): { innerHTML: string } | null;
  querySelector(selectors: string): { outerHTML: string; offsetWidth: number; offsetHeight: number } | null;
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

/** Ограничить промис таймаутом: зависший Chromium не подвесит вызов. */
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
 * Чистый Node-разбор BPMN: bpmn-moddle + bpmnlint. Не зависит от браузера,
 * поэтому работает и при недоступном Chromium. Методы не бросают.
 */
class NodeBpmnParser {
  private readonly moddle = new BpmnModdle();
  private linter?: InstanceType<typeof linterModule>;
  private readonly parseCache = new BoundedCache<DiagramValidation>(CACHE_LIMIT);
  private readonly layoutCache = new BoundedCache<LayoutOutcome>(CACHE_LIMIT);

  /** Разбор XML + lint с кешем по источнику. */
  async parse(source: string, renderer: RendererKind): Promise<DiagramValidation> {
    const key = sha256(['bpmn-parse', renderer, source]);
    const cached = this.parseCache.get(key);
    if (cached !== undefined) return cached;
    const validation = await this.parseFresh(source, renderer);
    this.parseCache.set(key, validation);
    return validation;
  }

  /** Автораскладка bpmn-auto-layout с кешем по источнику. */
  async layout(source: string): Promise<LayoutOutcome> {
    const key = sha256(['bpmn-layout', source]);
    const cached = this.layoutCache.get(key);
    if (cached !== undefined) return cached;
    let outcome: LayoutOutcome;
    try {
      const result = await layoutProcess(source);
      outcome = { ok: true, xml: result.xml };
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.layoutCache.set(key, outcome);
    return outcome;
  }

  /** Разбор без кеша: ошибка XML структурируется. */
  private async parseFresh(source: string, renderer: RendererKind): Promise<DiagramValidation> {
    let rootElement: BpmnModdleRootElement;
    try {
      const parsed = await this.moddle.fromXML(source);
      rootElement = parsed.rootElement;
    } catch (error) {
      return {
        syntax: 'error',
        renderer,
        error: { message: error instanceof Error ? error.message : String(error) }
      };
    }
    const lint = await this.lintSource(rootElement);
    return {
      syntax: 'ok',
      renderer,
      diagramType: 'bpmn',
      hasDiagram: (rootElement.diagrams ?? []).length > 0,
      ...(lint.length > 0 ? { lint } : {})
    };
  }

  /** bpmnlint с фиксированным конфигом; сбой линтера не блокирует публикацию. */
  private async lintSource(moddleRoot: object): Promise<BpmnLintIssue[]> {
    try {
      const rules: Record<string, string> = {};
      for (const name of LINT_RULES) rules[name] = LINT_SEVERITY;
      const report = await this.getLinter().lint(moddleRoot, { rules });
      const issues: BpmnLintIssue[] = [];
      for (const [rule, entries] of Object.entries(report)) {
        for (const entry of entries) {
          // Сбойное правило (category 'rule-error') и неожиданные значения — тихо пропускаем.
          const severity =
            entry.category === 'error' || entry.category === 'warn' || entry.category === 'info'
              ? entry.category
              : undefined;
          if (severity === undefined || typeof entry.message !== 'string' || entry.message.length === 0) continue;
          issues.push({ rule, severity, message: entry.message });
        }
      }
      return issues;
    } catch (error) {
      console.error('[livenote] bpmn-валидатор: bpmnlint не выполнился, замечания недоступны:', error instanceof Error ? error.message : error);
      return [];
    }
  }

  /** Ленивый синглтон линтера. */
  private getLinter(): InstanceType<typeof linterModule> {
    if (this.linter === undefined) {
      this.linter = new linterModule({ resolver: new NodeResolver() });
    }
    return this.linter;
  }
}

/**
 * BPMN-валидатор с headless Chromium (bpmn-js): parse и layout — чистый Node,
 * render — ленивая страница с восстановлением после сбоя. Все операции с
 * браузером сериализуются через очередь: страница одна.
 */
export class NodeBrowserBpmnValidator implements BpmnValidator {
  readonly kind = 'playwright' as const;

  private readonly parser = new NodeBpmnParser();
  private browser?: Browser;
  private page?: Page;
  private readonly renderCache = new BoundedCache<RenderOutcome>(CACHE_LIMIT);
  /** Очередь, гарантирующая поочерёдный доступ к единственной странице. */
  private queue: Promise<unknown> = Promise.resolve();

  async parse(source: string): Promise<DiagramValidation> {
    return this.parser.parse(source, this.kind);
  }

  async layout(source: string): Promise<LayoutOutcome> {
    return this.parser.layout(source);
  }

  async render(source: string, options?: { includeImage?: boolean }): Promise<RenderOutcome> {
    const includeImage = options?.includeImage === true;
    return this.exclusive(async () => {
      const key = sha256(['bpmn-render', source, includeImage ? 'png' : 'svg']);
      const cached = this.renderCache.get(key);
      if (cached !== undefined) return cached;
      let outcome: RenderOutcome;
      try {
        const validation = await this.parser.parse(source, this.kind);
        // Синтаксическая ошибка — рендер не выполняется, это нормальный ответ.
        outcome =
          validation.syntax === 'ok' ? await this.renderViaBrowser(source, validation, includeImage) : { validation };
      } catch {
        // Две неудачные попытки — окружение недоступно, честная деградация.
        outcome = { validation: NOT_CHECKED };
      }
      this.renderCache.set(key, outcome);
      return outcome;
    });
  }

  /** Первичная инициализация: фабрика вызывает сразу, чтобы уметь честно деградировать. */
  async warmUp(): Promise<void> {
    await this.exclusive(() => this.attempt('init', () => this.ensurePage().then(() => undefined)));
  }

  /** render через браузер: рисунок, опциональный PNG, очистка и восстановление страницы. */
  private async renderViaBrowser(
    source: string,
    validation: DiagramValidation,
    includeImage: boolean
  ): Promise<RenderOutcome> {
    const { outcome, pngBase64 } = await this.attempt('render', (page) => this.drawDiagram(page, source, includeImage));
    if (!outcome.ok || outcome.svg === undefined) {
      // importXML отклонился вопреки успешному parse — честная синтаксическая ошибка.
      return {
        validation: {
          syntax: 'error',
          renderer: this.kind,
          error: { message: outcome.message ?? 'Неизвестная ошибка bpmn-js' }
        }
      };
    }
    return {
      validation,
      render: {
        svg: outcome.svg,
        ...(outcome.width !== undefined ? { width: outcome.width } : {}),
        ...(outcome.height !== undefined ? { height: outcome.height } : {}),
        ...(pngBase64 !== undefined ? { pngBase64 } : {})
      }
    };
  }

  /** Рисование в браузере: evaluate, опциональный PNG, очистка viewer'а. */
  private async drawDiagram(
    page: Page,
    source: string,
    includeImage: boolean
  ): Promise<{ outcome: BrowserRenderOutcome; pngBase64?: string }> {
    const outcome = await this.evaluateRender(page, source);
    if (!outcome.ok || outcome.svg === undefined) {
      await this.discardViewer(page).catch(() => undefined);
      return { outcome };
    }
    // PNG некритичен: при сбое скриншота отдаём результат без него.
    const pngBase64 = includeImage ? await this.screenshot(page).catch(() => undefined) : undefined;
    await this.discardViewer(page).catch(() => undefined);
    if (includeImage) {
      // После скриншота восстанавливаем страницу: окружение пересоздаст ensurePage.
      await page.reload().catch(() => undefined);
    }
    return { outcome, ...(pngBase64 !== undefined ? { pngBase64 } : {}) };
  }

  /** Одна попытка; при сбое — закрыть страницу, пересоздать окружение и повторить ровно один раз. */
  private async attempt<T>(label: string, task: (page: Page) => Promise<T>): Promise<T> {
    try {
      // Таймаут накрывает и подготовку страницы, и саму операцию.
      return await withTimeout(task(await this.ensurePage()), label);
    } catch (firstError) {
      const reason = firstError instanceof Error ? firstError.message : firstError;
      console.error(`[livenote] bpmn-валидатор: "${label}" не удалась, пересоздаю окружение:`, reason);
      await this.page?.close().catch(() => undefined);
      this.page = undefined;
      return withTimeout(task(await this.ensurePage()), label);
    }
  }

  /**
   * Ленивый синглтон страницы: живая страница с загруженным bpmn-js. Браузер и страница
   * создаются при первом вызове и пересоздаются при потере (page.isClosed, отключение
   * браузера, отсутствие глобала BpmnJS — например после reload).
   */
  private async ensurePage(): Promise<Page> {
    const existing = this.page;
    if (existing !== undefined && !existing.isClosed() && (await this.hasViewer(existing))) {
      return existing;
    }
    if (this.browser === undefined || !this.browser.isConnected()) {
      if (this.browser !== undefined) await this.browser.close().catch(() => undefined);
      this.browser = await (await import('playwright')).chromium.launch({ headless: true });
    }
    const page = existing !== undefined && !existing.isClosed() ? existing : await this.browser.newPage({ viewport: VIEWPORT });
    page.setDefaultTimeout(OPERATION_TIMEOUT_MS);
    this.page = page;
    await this.prepareEnvironment(page);
    return page;
  }

  /** Окружение страницы: UMD-бандл bpmn-js поверх контейнера с явным размером. */
  private async prepareEnvironment(page: Page): Promise<void> {
    const path = createRequire(import.meta.url).resolve('bpmn-js/dist/bpmn-navigated-viewer.production.min.js');
    if (!existsSync(path)) throw new Error(`UMD-бандл bpmn-js не найден: ${path}`);
    await page.setContent(BASE_HTML);
    await page.addScriptTag({ path });
    const loaded = await page.evaluate(() => typeof (globalThis as { BpmnJS?: unknown }).BpmnJS === 'function');
    if (!loaded) throw new Error('UMD-скрипт bpmn-js не определил глобал BpmnJS');
  }

  /** Проверка, что глобал BpmnJS доступен (после reload его нет). */
  private async hasViewer(page: Page): Promise<boolean> {
    try {
      return await withTimeout(
        page.evaluate(() => typeof (globalThis as { BpmnJS?: unknown }).BpmnJS === 'function'),
        'проверка bpmn-js'
      );
    } catch {
      return false;
    }
  }

  /** Разбор и отрисовка в браузере; ошибки bpmn-js отдаются структурированным результатом. */
  private evaluateRender(page: Page, source: string): Promise<BrowserRenderOutcome> {
    return page.evaluate(async (src): Promise<BrowserRenderOutcome> => {
      const BpmnJS = (globalThis as { BpmnJS?: new (options: { container: string }) => BrowserViewer }).BpmnJS;
      const doc = (globalThis as { document?: BrowserDocument }).document;
      if (BpmnJS === undefined || doc === undefined) throw new Error('bpmn-js или DOM не загружены в странице');
      const canvas = doc.getElementById('canvas');
      if (canvas === null) throw new Error('контейнер #canvas не найден');
      canvas.innerHTML = '';
      const viewer = new BpmnJS({ container: '#canvas' });
      (globalThis as { __livenoteBpmnViewer?: BrowserViewer }).__livenoteBpmnViewer = viewer;
      try {
        const imported = await viewer.importXML(src);
        viewer.get('canvas').zoom('fit-viewport');
        const container = doc.querySelector('.djs-container');
        if (container === null) throw new Error('bpmn-js не создал контейнер .djs-container');
        return {
          ok: true,
          svg: container.outerHTML,
          width: container.offsetWidth,
          height: container.offsetHeight,
          warnings: imported.warnings.length
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }, source);
  }

  /** Разрушить viewer и очистить контейнер: страница остаётся готовой к следующему рендеру. */
  private async discardViewer(page: Page): Promise<void> {
    await page.evaluate(() => {
      const holder = globalThis as { __livenoteBpmnViewer?: BrowserViewer };
      holder.__livenoteBpmnViewer?.destroy();
      holder.__livenoteBpmnViewer = undefined;
      const canvas = (globalThis as { document?: BrowserDocument }).document?.getElementById('canvas');
      if (canvas !== undefined && canvas !== null) canvas.innerHTML = '';
    });
  }

  /** PNG-скриншот контейнера bpmn-js с отрисованной диаграммой. */
  private async screenshot(page: Page): Promise<string> {
    // omitBackground даёт прозрачный фон: собственный белый фон .djs-container
    // (из diagram-js.css) не отрисовывается, остаётся только схема.
    const png = await page.locator('.djs-container').screenshot({ type: 'png', omitBackground: true });
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
 * Деградировавший валидатор: Chromium недоступен, поэтому render даёт
 * «not_checked», но parse (moddle + lint) и layout работают в чистом Node.
 */
export class UnavailableBpmnValidator implements BpmnValidator {
  readonly kind = 'unavailable' as const;

  private readonly parser = new NodeBpmnParser();

  parse(source: string): Promise<DiagramValidation> {
    return this.parser.parse(source, this.kind);
  }

  layout(source: string): Promise<LayoutOutcome> {
    return this.parser.layout(source);
  }

  render(): Promise<RenderOutcome> {
    return Promise.resolve({ validation: NOT_CHECKED });
  }
}

/**
 * Фабрика BPMN-валидатора. Никогда не бросает: если Chromium недоступен,
 * возвращается UnavailableBpmnValidator с честным parse (moddle + lint в Node).
 */
export async function createBpmnValidator(): Promise<BpmnValidator> {
  const validator = new NodeBrowserBpmnValidator();
  try {
    await validator.warmUp();
    return validator;
  } catch (error) {
    console.error(
      '[livenote] BPMN-рендер недоступен (Chromium не поднялся), проверка XML будет без браузера:',
      error instanceof Error ? error.message : error
    );
    return new UnavailableBpmnValidator();
  }
}
