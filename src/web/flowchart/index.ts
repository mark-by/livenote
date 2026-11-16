import { parseFlowchart, validNodeId } from './parser';
import type { EdgeSpan, ParsedFlowchart, Span, Statement } from './parser';
import { FlowchartEditError } from './types';
import type { FlowchartEdit, FlowchartModel } from './types';

export { FlowchartEditError } from './types';
export type { FlowchartEdit, FlowchartModel, FlowchartNode, FlowchartEdge } from './types';

/** Неподдерживаемый синтаксис отключает визуальное редактирование, сохраняя исходник. */
export function readFlowchart(source: string): FlowchartModel | null {
  try {
    return parseFlowchart(source).model;
  } catch (error) {
    if (error instanceof FlowchartEditError) return null;
    throw error;
  }
}

function quoted(label: string): string {
  return `"${label.replace(/#/g, '#35;').replace(/"/g, '#quot;')}"`;
}

interface Replacement extends Span {
  text: string;
}

function replace(source: string, replacements: Replacement[]): string {
  for (const { start, end, text } of replacements.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + text + source.slice(end);
  }
  return source;
}

function append(source: string, statement: string): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return source + (source.endsWith('\n') ? '' : newline) + `  ${statement}${newline}`;
}

function nodeExists(parsed: ParsedFlowchart, id: string): void {
  if (!parsed.model.nodes.some((node) => node.id === id)) {
    throw new FlowchartEditError(`Узел «${id}» не найден.`);
  }
}

function edgeById(parsed: ParsedFlowchart, id: string): EdgeSpan {
  const index = parsed.model.edges.findIndex((edge) => edge.id === id);
  const edge = parsed.statements.flatMap((statement) => statement.edges)[index];
  if (!edge) throw new FlowchartEditError(`Связь «${id}» не найдена.`);
  return edge;
}

/** Перестраивает только затронутую цепочку; целые участки сохраняют исходный текст. */
function removeFromStatement(source: string, statement: Statement, edges: Set<EdgeSpan>, nodeId?: string): string {
  const parts: string[] = [];
  let index = 0;
  while (index < statement.nodes.length) {
    const first = statement.nodes[index]!;
    if (first.id === nodeId) {
      index += 1;
      continue;
    }
    let last = index;
    while (last < statement.edges.length && !edges.has(statement.edges[last]!)) last += 1;
    parts.push(source.slice(first.start, statement.nodes[last]!.end));
    index = last + 1;
  }
  return parts.join('; ');
}

function removeReferences(source: string, parsed: ParsedFlowchart, deletedEdges: Set<EdgeSpan>, nodeId?: string): Replacement[] {
  const changes: Replacement[] = [];
  const allEdges = parsed.statements.flatMap((statement) => statement.edges);
  const removedNames = new Set([...deletedEdges].flatMap((edge) => edge.naturalId ? [edge.naturalId] : []));
  if (nodeId) removedNames.add(nodeId);
  for (const statement of parsed.statements) {
    if (statement.kind !== 'directive') continue;
    const text = source.slice(statement.start, statement.end);
    const refs = /^(style|click|class)\s+([^\s,]+(?:\s*,\s*[^\s,]+)*)([\s\S]*)$/.exec(text);
    if (refs) {
      const ids = refs[2]!.split(',').map((id) => id.trim());
      const keep = ids.filter((id) => !removedNames.has(id));
      if (keep.length !== ids.length) {
        changes.push({ ...statement, text: keep.length ? `${refs[1]} ${keep.join(',')}${refs[3]}` : '' });
      }
    }
    const style = /^linkStyle\s+(\d+(?:\s*,\s*\d+)*)(\s[\s\S]*)$/.exec(text);
    if (style && deletedEdges.size) {
      const indices = style[1]!.split(',').map(Number);
      const keep = indices.filter((index) => !deletedEdges.has(allEdges[index]!)).map((index) =>
        index - allEdges.slice(0, index).filter((edge) => deletedEdges.has(edge)).length,
      );
      changes.push({ ...statement, text: keep.length ? `linkStyle ${keep.join(',')}${style[2]}` : '' });
    } else if (/^linkStyle\s/.test(text) && !/^linkStyle\s+default\s/.test(text) && !style && deletedEdges.size) {
      throw new FlowchartEditError('Не удалось безопасно обновить директиву linkStyle после удаления связей.');
    }
  }
  return changes;
}

export function applyFlowchartEdit(source: string, edit: FlowchartEdit): string {
  const parsed = parseFlowchart(source);
  switch (edit.type) {
    case 'addNode':
      if (!validNodeId(edit.id)) throw new FlowchartEditError('Идентификатор узла должен начинаться с буквы или подчёркивания.');
      if (parsed.model.nodes.some((node) => node.id === edit.id) || parsed.groups.has(edit.id)) {
        throw new FlowchartEditError('Этот идентификатор узла или подграфа уже существует.');
      }
      return append(source, `${edit.id}[${quoted(edit.label)}]`);
    case 'addEdge':
      nodeExists(parsed, edit.from);
      nodeExists(parsed, edit.to);
      return append(source, `${edit.from} -->${edit.label ? `|${quoted(edit.label)}|` : ''} ${edit.to}`);
    case 'renameNode': {
      nodeExists(parsed, edit.id);
      const nodes = parsed.statements.flatMap((statement) => statement.nodes).filter((node) => node.id === edit.id);
      const explicit = nodes.filter((node) => node.label);
      if (!explicit.length) {
        const node = nodes[0]!;
        return replace(source, [{ start: node.start + node.id.length, end: node.start + node.id.length, text: `[${quoted(edit.label)}]` }]);
      }
      return replace(source, explicit.map((node) => ({ ...node.label!, text: quoted(edit.label) })));
    }
    case 'updateEdgeLabel': {
      const edge = edgeById(parsed, edit.id);
      return replace(source, [{
        ...edge.connector,
        text: `${edge.operator}${edit.label ? `|${quoted(edit.label)}|` : ''}`,
      }]);
    }
    case 'removeNode':
    case 'removeEdge': {
      if (edit.type === 'removeNode') nodeExists(parsed, edit.id);
      const selected = edit.type === 'removeEdge' ? edgeById(parsed, edit.id) : null;
      const nodeId = edit.type === 'removeNode' ? edit.id : undefined;
      const deleted = new Set(parsed.statements.flatMap((statement) => statement.edges).filter((edge) =>
        edge === selected || edge.from.id === nodeId || edge.to.id === nodeId,
      ));
      const changes = removeReferences(source, parsed, deleted, nodeId);
      for (const statement of parsed.statements) {
        if (statement.nodes.some((node) => node.id === nodeId) || statement.edges.some((edge) => deleted.has(edge))) {
          changes.push({ ...statement, text: removeFromStatement(source, statement, deleted, nodeId) });
        }
      }
      return replace(source, changes);
    }
  }
}
