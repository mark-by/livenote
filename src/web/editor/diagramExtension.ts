import { EditorSelection, EditorState, Facet, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { DiagramRenderer, EditorDiagram } from './types';
import { parseEditorDiagrams } from './parseDiagrams';

export const diagramRenderer = Facet.define<DiagramRenderer, DiagramRenderer | undefined>({
  combine: values => values[0]
});

const roots = new WeakMap<HTMLElement, Root>();
const observers = new WeakMap<HTMLElement, ResizeObserver>();

class DiagramWidget extends WidgetType {
  constructor(
    readonly diagram: EditorDiagram,
    readonly render: DiagramRenderer
  ) { super(); }

  override eq(other: DiagramWidget) {
    return this.diagram.from === other.diagram.from && this.diagram.to === other.diagram.to &&
      this.diagram.source === other.diagram.source && this.diagram.target === other.diagram.target &&
      this.diagram.label === other.diagram.label && this.render === other.render;
  }

  mount(element: HTMLElement) {
    let root = roots.get(element);
    if (!root) {
      root = createRoot(element);
      roots.set(element, root);
    }
    element.dataset.from = String(this.diagram.from);
    element.dataset.to = String(this.diagram.to);
    root.render(this.render(this.diagram));
  }

  override toDOM(view: EditorView) {
    const element = document.createElement('div');
    element.className = 'lp-diagram';
    element.contentEditable = 'false';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', 'Встроенная диаграмма');
    this.mount(element);
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(element);
    observers.set(element, observer);
    return element;
  }

  override updateDOM(element: HTMLElement) {
    this.mount(element);
    return true;
  }

  override destroy(element: HTMLElement) {
    observers.get(element)?.disconnect();
    observers.delete(element);
    const root = roots.get(element);
    roots.delete(element);
    queueMicrotask(() => root?.unmount());
  }

  override ignoreEvent() { return true; }
}

function diagramDecorations(state: EditorState) {
  const render = state.facet(diagramRenderer);
  if (!render) return Decoration.none;
  const marks: Range<Decoration>[] = [];
  for (const diagram of parseEditorDiagrams(state.doc.toString())) {
    marks.push(Decoration.replace({
      block: true,
      inclusive: false,
      widget: new DiagramWidget(diagram, render)
    }).range(diagram.from, diagram.to));
  }
  return Decoration.set(marks, true);
}

export const diagramField = StateField.define<DecorationSet>({
  create: diagramDecorations,
  update(value, transaction) {
    return transaction.docChanged ||
      transaction.startState.facet(diagramRenderer) !== transaction.state.facet(diagramRenderer)
      ? diagramDecorations(transaction.state) : value;
  },
  provide: field => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of(view => view.state.field(field))
  ]
});

// Vim задаёт selection напрямую, минуя atomicRanges. Ни один endpoint не входит в скрытый исходник.
export const diagramSelection = EditorState.transactionFilter.of(transaction => {
  if (!transaction.selection || !transaction.startState.facet(diagramRenderer)) return transaction;
  const diagrams = parseEditorDiagrams(transaction.newDoc.toString());
  const previous = transaction.startState.selection.main;
  const snap = (position: number, before: number) => {
    const diagram = diagrams.find(range => position > range.from && position < range.to);
    if (!diagram) return position;
    return position > before ? diagram.to : diagram.from;
  };
  const selection = EditorSelection.create(transaction.newSelection.ranges.map(range =>
    EditorSelection.range(snap(range.anchor, previous.anchor), snap(range.head, previous.head))
  ), transaction.newSelection.mainIndex);
  return selection.eq(transaction.newSelection) ? transaction : [
    transaction, { selection, sequential: true }
  ];
});
