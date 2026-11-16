/**
 * Описания типов для npm-пакетов без собственных деклараций (bpmn-moddle,
 * bpmn-auto-layout, bpmnlint). Контракты минимальны — ровно то, что использует
 * серверный BPMN-валидатор (src/server/validator/bpmn.ts).
 */

declare module 'bpmn-moddle' {
  /** Корень разобранного BPMN-документа (bpmn:Definitions). */
  export interface BpmnModdleRootElement {
    /** Секция BPMNDI; отсутствует, если XML без геометрии. */
    readonly diagrams?: readonly unknown[];
  }

  /** Результат fromXML. */
  export interface BpmnModdleParseResult {
    rootElement: BpmnModdleRootElement;
    warnings: readonly unknown[];
  }

  export class BpmnModdle {
    constructor(packages?: unknown, options?: unknown);
    fromXML(xml: string, options?: Record<string, unknown>): Promise<BpmnModdleParseResult>;
  }
}

declare module 'bpmn-auto-layout' {
  /** Ошибка автораскладки. */
  export class LayoutError extends Error {}

  export interface LayoutProcessResult {
    xml: string;
    warnings: readonly unknown[];
  }

  export function layoutProcess(xml: string): Promise<LayoutProcessResult>;
}

declare module 'bpmnlint/lib/linter.js' {
  /** Запись отчёта одного правила. */
  export interface BpmnLintReportEntry {
    id?: string;
    message: string;
    /** Серьёзность из конфига ('warn' | 'error' | 'info') или 'rule-error' при сбое правила. */
    category?: string;
  }

  export interface BpmnLintReport {
    [ruleName: string]: BpmnLintReportEntry[];
  }

  /** Параметры Linter: резолвер правил обязателен. */
  export interface BpmnLinterOptions {
    config?: unknown;
    resolver: {
      resolveRule(pkg: string, ruleName: string): unknown;
      resolveConfig(pkg: string, configName: string): unknown;
    };
  }

  /** Конфиг lint: значения правил ('off' | 'warn' | 'error' | 'info' | число | [значение, опции]). */
  export interface BpmnLintConfig {
    rules?: Record<string, string | number | readonly [string | number, unknown]>;
  }

  class Linter {
    constructor(options: BpmnLinterOptions);
    lint(moddleRoot: object, config: BpmnLintConfig): Promise<BpmnLintReport>;
  }

  export = Linter;
}

declare module 'bpmnlint/lib/resolver/node-resolver.js' {
  class NodeResolver {
    constructor(options?: { require?: unknown; requireLocal?: unknown });
    resolveRule(pkg: string, ruleName: string): unknown;
    resolveConfig(pkg: string, configName: string): unknown;
  }

  export = NodeResolver;
}
