import { parse, validId } from './parser';
import type { Parsed, Span } from './parser';
import { CLASS_RELATIONS, ClassDiagramEditError } from './types';
import type { ClassDiagramEdit, ClassDiagramModel, ClassRelation } from './types';

export { CLASS_RELATIONS, ClassDiagramEditError } from './types';
export type { ClassDiagramEdit, ClassDiagramModel, ClassRelation } from './types';

export function readClassDiagram(source: string): ClassDiagramModel | null {
  try {
    return parse(source).model;
  } catch (error) {
    if (error instanceof ClassDiagramEditError) return null;
    throw error;
  }
}

interface Replacement extends Span { text: string }
function replace(source: string, changes: Replacement[]): string {
  for (const { start, end, text } of changes.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + text + source.slice(end);
  }
  return source;
}
function append(source: string, statements: string[]): string {
  if (!statements.length) return source;
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  return source + (source.endsWith('\n') ? '' : nl) + statements.map((text) => `  ${text}${nl}`).join('');
}
function node(parsed: Parsed, id: string): void {
  if (!parsed.model.nodes.some((item) => item.id === id)) {
    throw new ClassDiagramEditError(`Класс «${id}» не найден.`);
  }
}
function edge(parsed: Parsed, id: string) {
  const index = parsed.model.edges.findIndex((item) => item.id === id);
  if (index < 0) throw new ClassDiagramEditError(`Связь «${id}» не найдена.`);
  return parsed.edges[index]!;
}
function alias(label: string): string {
  if (/[\r\n\[\]]/.test(label)) throw new ClassDiagramEditError('Подпись класса не может содержать переносы строк или квадратные скобки.');
  return label.replace(/#/g, '#35;').replace(/"/g, '#quot;');
}
function edgeLabel(label: string): string {
  if (/[\r\n{};]/.test(label) || label.includes('%%')) throw new ClassDiagramEditError('Недопустимая подпись связи.');
  return label ? ` : ${label}` : '';
}
function relation(value: ClassRelation): ClassRelation {
  if (!CLASS_RELATIONS.includes(value)) throw new ClassDiagramEditError('Неизвестный тип связи.');
  return value;
}
function preserveNodes(source: string, parsed: Parsed, removed?: string): string {
  const remaining = parse(source);
  const ids = new Set(remaining.model.nodes.map((item) => item.id));
  return append(source, parsed.model.nodes.filter((item) => item.id !== removed && !ids.has(item.id))
    .map((item) => `class ${item.id}`));
}

export function applyClassDiagramEdit(source: string, edit: ClassDiagramEdit): string {
  const parsed = parse(source);
  switch (edit.type) {
    case 'addNode':
      if (!validId(edit.id) || parsed.namespaces.has(edit.id) || parsed.model.nodes.some((item) => item.id === edit.id)) {
        throw new ClassDiagramEditError('Недопустимый или занятый идентификатор класса.');
      }
      return append(source, [`class ${edit.id}["${alias(edit.label)}"]`]);
    case 'renameNode': {
      node(parsed, edit.id);
      const label = alias(edit.label);
      const declarations = parsed.nodes.filter((item) => item.id === edit.id && item.kind === 'declaration' && item.insert !== undefined);
      const existing = declarations.filter((item) => item.alias);
      if (existing.length) return replace(source, existing.map((item) => ({ ...item.alias!, text: label })));
      if (declarations.length) return replace(source, [{ start: declarations[0]!.insert!, end: declarations[0]!.insert!, text: `["${label}"]` }]);
      return append(source, [`class ${edit.id}["${label}"]`]);
    }
    case 'updateMembers': {
      node(parsed, edit.id);
      const members = edit.members.filter((member) => member.trim().length > 0);
      for (const member of members) {
        if (/[{};\r\n]/.test(member) || member.includes('%%')) {
          throw new ClassDiagramEditError('Элемент класса должен занимать одну строку без фигурных скобок и директив.');
        }
      }
      const changes = parsed.nodes.filter((item) => item.id === edit.id && item.kind === 'member').map((item) => ({ ...item, text: '' }));
      const updated = append(replace(source, changes), members.map((member) => `${edit.id} : ${member.trim()}`));
      return preserveNodes(updated, parsed);
    }
    case 'addEdge':
      node(parsed, edit.from);
      node(parsed, edit.to);
      return append(source, [`${edit.from} ${relation(edit.relation ?? '-->')} ${edit.to}${edgeLabel(edit.label ?? '')}`]);
    case 'updateEdgeLabel': {
      const selected = edge(parsed, edit.id);
      const text = edgeLabel(edit.label);
      const position = selected.label ?? { start: selected.end - (source.slice(selected.start, selected.end).endsWith('\r\n') ? 2 : source[selected.end - 1] === '\n' ? 1 : 0), end: selected.end - (source.slice(selected.start, selected.end).endsWith('\r\n') ? 2 : source[selected.end - 1] === '\n' ? 1 : 0) };
      return replace(source, [{ ...position, text: selected.label ? text.trimStart() : text }]);
    }
    case 'updateRelation':
      return replace(source, [{ ...edge(parsed, edit.id).operator, text: relation(edit.relation) }]);
    case 'removeEdge':
      return preserveNodes(replace(source, [{ ...edge(parsed, edit.id), text: '' }]), parsed);
    case 'removeNode': {
      node(parsed, edit.id);
      const changes: Replacement[] = [
        ...parsed.nodes.filter((item) => item.id === edit.id).map((item) => ({ ...item, text: '' })),
        ...parsed.edges.filter((item) => item.from === edit.id || item.to === edit.id).map((item) => ({ ...item, text: '' })),
      ];
      for (const directive of parsed.directives) {
        if (!directive.ids.includes(edit.id)) continue;
        const ids = directive.ids.filter((id) => id !== edit.id);
        changes.push({ ...directive, text: ids.length ? `${directive.prefix}${ids.join(',')}${directive.suffix}` : '' });
      }
      return preserveNodes(replace(source, changes), parsed, edit.id);
    }
  }
}
