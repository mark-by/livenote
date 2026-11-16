import { FlowchartEditError } from './types';
import type { FlowchartModel } from './types';

export interface Span {
  start: number;
  end: number;
}

export interface NodeSpan extends Span {
  id: string;
  label?: Span;
  value?: string;
}

export interface EdgeSpan extends Span {
  from: NodeSpan;
  to: NodeSpan;
  label?: Span;
  value: string;
  /** Весь оператор связи, включая необязательную подпись в вертикальных чертах. */
  connector: Span;
  /** Оператор до подписи либо объединённые половины оператора с подписью внутри. */
  operator: string;
  naturalId?: string;
}

export interface Statement extends Span {
  kind: 'nodes' | 'directive' | 'subgraph' | 'end' | 'header';
  nodes: NodeSpan[];
  edges: EdgeSpan[];
}

export interface ParsedFlowchart {
  model: FlowchartModel;
  statements: Statement[];
  groups: Set<string>;
}

const identifier = /^[\p{L}_][\p{L}\p{N}_]*(?:-[\p{L}\p{N}_]+)*/u;
const shapes: [string, string][] = [
  ['(((', ')))'], ['[[', ']]'], ['((', '))'], ['([', '])'],
  ['[(', ')]'], ['{{', '}}'], ['[/', '/]'], ['[\\', '\\]'],
  ['(-', '-)'], ['[', ']'], ['(', ')'], ['{', '}'], ['>', ']'],
];
const reserved = /^(?:end|subgraph|flowchart|graph|direction|style|classDef|class|click|linkStyle)$/;

function fail(): never {
  throw new FlowchartEditError('Эта блок-схема использует синтаксис, который не поддерживается визуальным редактором.');
}

export function validNodeId(id: string): boolean {
  return identifier.exec(id)?.[0] === id && !reserved.test(id);
}

export function decodeLabel(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  const named: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
  return text.replace(/#(quot|amp|lt|gt|apos|\d+);/g, (match, entity: string) => {
    const code = Number(entity);
    return named[entity] ?? (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match);
  });
}

/** Разделяет по синтаксическим границам, сохраняя исходный текст без изменений. */
function statements(source: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  let quote = false;
  let depth = 0;
  let pipe = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (!quote && !depth && !pipe && source.startsWith('%%', i)) {
      if (source.slice(start, i).trim()) spans.push({ start, end: i });
      if (source.startsWith('%%{', i)) {
        const end = source.indexOf('}%%', i + 3);
        if (end < 0) fail();
        i = end + 2;
      } else {
        const end = source.indexOf('\n', i);
        i = end < 0 ? source.length : end;
      }
      start = i + 1;
      continue;
    }
    if (char === '"') quote = !quote;
    if (quote) continue;
    if (char === '[' || char === '(' || char === '{') depth += 1;
    if (char === ']' || char === ')' || char === '}') depth = Math.max(0, depth - 1);
    if (!depth && char === '|') pipe = !pipe;
    if (!depth && !pipe && (char === '\n' || char === ';')) {
      if (source.slice(start, i).trim()) spans.push({ start, end: i });
      start = i + 1;
    }
  }
  if (quote || depth || pipe) fail();
  if (source.slice(start).trim()) spans.push({ start, end: source.length });
  return spans.map(({ start: a, end: b }) => {
    while (/\s/.test(source[a] ?? '') && a < b) a += 1;
    while (/\s/.test(source[b - 1] ?? '') && b > a) b -= 1;
    return { start: a, end: b };
  });
}

class StatementParser {
  position: number;
  constructor(private source: string, private span: Span) {
    this.position = span.start;
  }

  skip(): void {
    while (this.position < this.span.end && /\s/.test(this.source[this.position]!)) this.position += 1;
  }

  node(): NodeSpan {
    this.skip();
    const start = this.position;
    const id = identifier.exec(this.source.slice(start, this.span.end))?.[0];
    if (!id || !validNodeId(id)) fail();
    this.position += id.length;
    const node: NodeSpan = { id, start, end: this.position };
    this.skip();
    const opening = shapes.find(([open]) => this.source.startsWith(open, this.position));
    if (opening) {
      const [open, initialClose] = opening;
      const labelStart = this.position + open.length;
      let quote = false;
      let close = initialClose;
      let end = labelStart;
      for (; end < this.span.end; end += 1) {
        const char = this.source[end]!;
        if (char === '"') quote = !quote;
        if (quote) continue;
        // Разделители параллелограмма и трапеции могут смотреть в обе стороны.
        if ((open === '[/' || open === '[\\') && /[\\/]/.test(char) && this.source[end + 1] === ']') {
          close = `${char}]`;
          break;
        }
        if (this.source.startsWith(close, end)) break;
        if (/[()[\]{}]/.test(char)) fail();
      }
      if (end >= this.span.end || quote) fail();
      node.label = { start: labelStart, end };
      node.value = decodeLabel(this.source.slice(labelStart, end));
      this.position = end + close.length;
      node.end = this.position;
    }
    this.skip();
    if (this.source.startsWith(':::', this.position)) {
      this.position += 3;
      const classes = /^[A-Za-z_][\w-]*(?:,[A-Za-z_][\w-]*)*/.exec(this.source.slice(this.position))?.[0];
      if (!classes) fail();
      this.position += classes.length;
      node.end = this.position;
    }
    return node;
  }

  edge(from: NodeSpan): Omit<EdgeSpan, 'to'> {
    this.skip();
    const start = this.position;
    let naturalId: string | undefined;
    const named = /^([\p{L}_][\p{L}\p{N}_-]*)@/u.exec(this.source.slice(this.position));
    if (named) {
      naturalId = named[1]!;
      this.position += named[0].length;
    }
    const opStart = this.position;
    const rest = this.source.slice(this.position, this.span.end);
    const op = /^(?:[<ox])?(?:-{2,}(?:[>ox])?|={2,}>?|-\.+-?(?:[>ox])?)/.exec(rest)?.[0];
    if (!op) fail();
    this.position += op.length;
    const operatorEnd = this.position;
    this.skip();
    let label: Span | undefined;
    let operator = op;
    if (this.source[this.position] === '|') {
      const labelStart = ++this.position;
      let quoted = false;
      while (this.position < this.span.end) {
        const char = this.source[this.position]!;
        if (char === '"') quoted = !quoted;
        if (!quoted && char === '|') break;
        this.position += 1;
      }
      if (this.position === this.span.end || quoted) fail();
      label = { start: labelStart, end: this.position };
      this.position += 1;
    } else if (op === '--' || op === '-.' || op === '==') {
      // Подписи внутри оператора: A -- текст --> B, A -. текст .-> B.
      const closing = op === '--' ? /--+>/g : op === '-.' ? /\.-+>/g : /==+>/g;
      closing.lastIndex = this.position;
      let quoted = false;
      let end = this.position;
      for (; end < this.span.end; end += 1) {
        if (this.source[end] === '"') quoted = !quoted;
        closing.lastIndex = end;
        const match = !quoted ? closing.exec(this.source) : null;
        if (match?.index === end) {
          label = { start: this.position, end };
          this.position = end + match[0].length;
          operator = op === '--' ? '-->' : op === '-.' ? '-.->' : '==>';
          break;
        }
      }
      if (!label) fail();
    }
    if (!label) this.position = operatorEnd;
    return {
      start, end: this.position, from, label, operator, naturalId,
      value: label ? decodeLabel(this.source.slice(label.start, label.end)) : '',
      connector: { start: opStart, end: this.position },
    };
  }

  parse(): Pick<Statement, 'nodes' | 'edges'> {
    const nodes = [this.node()];
    const edges: EdgeSpan[] = [];
    this.skip();
    while (this.position < this.span.end) {
      const edge = this.edge(nodes[nodes.length - 1]!);
      const to = this.node();
      edges.push({ ...edge, to });
      nodes.push(to);
      this.skip();
    }
    return { nodes, edges };
  }
}

export function parseFlowchart(source: string): ParsedFlowchart {
  const spans = statements(source);
  const header = spans.shift();
  if (!header) fail();
  const match = /^(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)$/.exec(source.slice(header.start, header.end));
  if (!match) fail();
  const result: Statement[] = [{ ...header, kind: 'header', nodes: [], edges: [] }];
  let depth = 0;
  const groups = new Set<string>();
  for (const span of spans) {
    const text = source.slice(span.start, span.end).trim();
    let kind: Statement['kind'] = 'nodes';
    if (/^subgraph(?:\s|$)/.test(text)) {
      kind = 'subgraph';
      depth += 1;
      const id = /^subgraph\s+([\p{L}_][\p{L}\p{N}_-]*)(?:\s|\[|$)/u.exec(text)?.[1];
      if (id) groups.add(id);
    } else if (text === 'end') {
      kind = 'end';
      if (--depth < 0) fail();
    } else if (/^(?:style|classDef|class|click|linkStyle|accTitle|accDescr)\s/.test(text)) {
      kind = 'directive';
    } else if (/^direction\s+(?:TB|TD|BT|LR|RL)$/.test(text)) {
      if (!depth) fail();
      kind = 'directive';
    }
    const parsed = kind === 'nodes' ? new StatementParser(source, span).parse() : { nodes: [], edges: [] };
    result.push({ ...span, kind, ...parsed });
  }
  if (depth) fail();
  const nodes = new Map<string, { id: string; label: string }>();
  const edges: FlowchartModel['edges'] = [];
  const naturalIds = new Set<string>();
  for (const statement of result) {
    for (const node of statement.nodes) {
      if (groups.has(node.id)) fail(); // Связи с подграфами требуют другой модели редактирования.
      const old = nodes.get(node.id);
      if (!old || node.label) nodes.set(node.id, { id: node.id, label: node.value ?? old?.label ?? node.id });
    }
    for (const edge of statement.edges) {
      if (edge.naturalId) {
        if (naturalIds.has(edge.naturalId)) fail();
        naturalIds.add(edge.naturalId);
      }
      edges.push({ id: `edge-${edges.length}`, from: edge.from.id, to: edge.to.id, label: edge.value });
    }
  }
  for (const id of naturalIds) {
    if (nodes.has(id) || groups.has(id)) fail();
  }
  return { model: { direction: match[1]!, nodes: [...nodes.values()], edges }, statements: result, groups };
}
