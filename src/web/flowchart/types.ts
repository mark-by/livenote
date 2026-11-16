export interface FlowchartNode {
  id: string;
  label: string;
}

export interface FlowchartEdge {
  /** Порядковый номер в исходнике: после каждого изменения модель читается заново. */
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface FlowchartModel {
  direction: string;
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
}

export type FlowchartEdit =
  | { type: 'renameNode'; id: string; label: string }
  | { type: 'addNode'; id: string; label: string }
  | { type: 'removeNode'; id: string }
  | { type: 'addEdge'; from: string; to: string; label?: string }
  | { type: 'updateEdgeLabel'; id: string; label: string }
  | { type: 'removeEdge'; id: string };

export class FlowchartEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowchartEditError';
  }
}
