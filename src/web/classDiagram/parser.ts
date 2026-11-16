import { CLASS_RELATIONS, ClassDiagramEditError } from './types';
import type { ClassDiagramModel, ClassRelation } from './types';

export interface Span { start: number; end: number }
export interface Line extends Span { text: string; content: string; contentStart: number }
export interface NodePart extends Span { id: string; kind: 'declaration' | 'member'; alias?: Span; insert?: number }
export interface EdgePart extends Span { operator: Span; label?: Span; from: string; to: string }
export interface Directive extends Span { kind: 'style' | 'cssClass'; ids: string[]; prefix: string; suffix: string }
export interface Parsed {
  model: ClassDiagramModel;
  nodes: NodePart[];
  edges: EdgePart[];
  directives: Directive[];
  namespaces: Set<string>;
}

const idPattern = '[A-Za-z_][A-Za-z0-9_]*';
const idRe = new RegExp(`^${idPattern}$`);
const reserved = /^(?:classDiagram|class|namespace|direction|style|classDef|cssClass)$/;
export const validId = (id: string): boolean => idRe.test(id) && !reserved.test(id);
export function fail(): never {
  throw new ClassDiagramEditError('Диаграмма классов содержит неподдерживаемый или неоднозначный синтаксис.');
}
export function decode(text: string): string {
  return text.replace(/#(quot|amp|lt|gt|apos|\d+);/g, (original, entity: string) => {
    const named: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
    const code = Number(entity);
    return named[entity] ?? (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original);
  });
}
export function lines(source: string): Line[] {
  const result: Line[] = [];
  const re = /[^\r\n]*(?:\r\n|\n|$)/g;
  for (const match of source.matchAll(re)) {
    if (!match[0]) continue;
    const text = match[0].replace(/\r?\n$/, '');
    const start = match.index!;
    const trimmed = text.trim();
    const leading = text.length - text.trimStart().length;
    result.push({ start, end: start + match[0].length, text, content: trimmed, contentStart: start + leading });
  }
  return result;
}

export function parse(source: string): Parsed {
  const all = lines(source);
  const model: ClassDiagramModel = { direction: 'TB', nodes: [], edges: [] };
  const nodes: NodePart[] = [];
  const edges: EdgePart[] = [];
  const directives: Directive[] = [];
  const namespaces = new Set<string>();
  const byId = new Map<string, ClassDiagramModel['nodes'][number]>();
  let header = false;
  let direction = false;
  let namespace: string | undefined;
  let block: { id: string } | undefined;
  const getNode = (id: string) => {
    if (!validId(id) || namespaces.has(id)) fail();
    let node = byId.get(id);
    if (!node) {
      node = { id, label: id, members: [] };
      byId.set(id, node);
      model.nodes.push(node);
    }
    return node;
  };
  for (const line of all) {
    const text = line.content;
    if (!text || text.startsWith('%%')) {
      if (text.startsWith('%%{')) fail();
      continue;
    }
    if (!header) {
      if (text !== 'classDiagram') fail();
      header = true;
      continue;
    }
    if (block) {
      if (text === '}') {
        nodes.push({ id: block.id, kind: 'declaration', start: line.start, end: line.end });
        block = undefined;
      } else {
        if (/[{};\r\n]/.test(text) || text.startsWith('%%')) fail();
        getNode(block.id).members.push(text);
        nodes.push({ id: block.id, kind: 'member', start: line.start, end: line.end });
      }
      continue;
    }
    if (text === '}') {
      if (!namespace) fail();
      namespace = undefined;
      continue;
    }
    let m = /^direction\s+(TB|BT|LR|RL)$/.exec(text);
    if (m) {
      if (namespace || direction) fail();
      direction = true;
      model.direction = m[1]!;
      continue;
    }
    m = new RegExp(`^namespace\\s+(${idPattern})\\s*\\{$`).exec(text);
    if (m) {
      if (namespace || !validId(m[1]!) || byId.has(m[1]!) || namespaces.has(m[1]!)) fail();
      namespace = m[1]!;
      namespaces.add(namespace);
      continue;
    }
    m = new RegExp(`^class\\s+(${idPattern})(?:\\["([^"\\]\\r\\n]*)"\\])?\\s*(\\{)?$`).exec(text);
    if (m) {
      const id = m[1]!;
      const node = getNode(id);
      const idEnd = line.contentStart + text.indexOf(id, 'class'.length) + id.length;
      let alias: Span | undefined;
      if (m[2] !== undefined) {
        if (node.label !== id) fail();
        const start = line.contentStart + text.indexOf('["') + 2;
        alias = { start, end: start + m[2].length };
        node.label = decode(m[2]);
      }
      nodes.push({ id, kind: 'declaration', start: line.start, end: line.end, alias, insert: idEnd });
      if (m[3]) block = { id };
      continue;
    }
    m = new RegExp(`^(${idPattern})\\s*:\\s*(.+)$`).exec(text);
    if (m) {
      if (/[{};\r\n]/.test(m[2]!)) fail();
      getNode(m[1]!).members.push(m[2]!.trim());
      nodes.push({ id: m[1]!, kind: 'member', start: line.start, end: line.end });
      continue;
    }
    const op = CLASS_RELATIONS.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    m = new RegExp(`^(${idPattern})\\s+(?:"([^"\\r\\n]*)"\\s+)?(${op})\\s+(?:"([^"\\r\\n]*)"\\s+)?(${idPattern})(?:\\s*:\\s*(.*))?$`).exec(text);
    if (m) {
      getNode(m[1]!);
      getNode(m[5]!);
      const operatorStart = line.contentStart + text.indexOf(m[3]!, m[1]!.length);
      const labelStart = m[6] === undefined ? undefined : line.contentStart + text.indexOf(':', operatorStart - line.contentStart + m[3]!.length);
      model.edges.push({ id: `edge-${edges.length}`, from: m[1]!, to: m[5]!, relation: m[3] as ClassRelation, label: m[6]?.trim() ?? '' });
      edges.push({ start: line.start, end: line.end, operator: { start: operatorStart, end: operatorStart + m[3]!.length }, label: labelStart === undefined ? undefined : { start: labelStart, end: line.contentStart + text.length }, from: m[1]!, to: m[5]! });
      continue;
    }
    m = new RegExp(`^(style|cssClass)\\s+(${idPattern}(?:\\s*,\\s*${idPattern})*)\\s+(.+)$`).exec(text);
    if (m) {
      const ids = m[2]!.split(',').map((id) => id.trim());
      directives.push({ start: line.contentStart, end: line.contentStart + text.length, kind: m[1] as 'style' | 'cssClass', ids, prefix: `${m[1]} `, suffix: text.slice(text.indexOf(m[2]!) + m[2]!.length) });
      continue;
    }
    if (/^classDef\s+[A-Za-z_][\w-]*\s+[^{};]+$/.test(text)) continue;
    fail();
  }
  if (!header || block || namespace) fail();
  return { model, nodes, edges, directives, namespaces };
}
