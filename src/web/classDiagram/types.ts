export const CLASS_RELATIONS = [
  '<|--', '--|>', '*--', '--*', 'o--', '--o', '-->', '<--', '--',
  '..>', '<..', '..|>', '<|..', '..',
] as const;

export type ClassRelation = typeof CLASS_RELATIONS[number];
export interface ClassDiagramModel {
  direction: string;
  nodes: { id: string; label: string; members: string[] }[];
  edges: { id: string; from: string; to: string; label: string; relation: ClassRelation }[];
}
export type ClassDiagramEdit =
  | { type: 'renameNode'; id: string; label: string }
  | { type: 'addNode'; id: string; label: string }
  | { type: 'removeNode'; id: string }
  | { type: 'addEdge'; from: string; to: string; label?: string; relation?: ClassRelation }
  | { type: 'updateEdgeLabel'; id: string; label: string }
  | { type: 'removeEdge'; id: string }
  | { type: 'updateMembers'; id: string; members: string[] }
  | { type: 'updateRelation'; id: string; relation: ClassRelation };

export class ClassDiagramEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassDiagramEditError';
  }
}
