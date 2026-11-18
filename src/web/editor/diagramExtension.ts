import { EditorSelection, EditorState, Facet, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { getThemeVersion } from '../mermaidInit';
import type { DiagramRenderer, EditorDiagram } from './types';
import { parseEditorDiagrams } from './parseDiagrams';

export const diagramRenderer = Facet.define<DiagramRenderer, DiagramRenderer | undefined>({
  combine: values => values[0]
});

const roots = new WeakMap<HTMLElement, Root>();
const observers = new WeakMap<HTMLElement, () => void>();

interface DiagramMeasurement {
  readonly view: WeakRef<EditorView>;
  readonly width: number;
  readonly editorTheme: boolean;
  readonly mermaidTheme: number;
  readonly height: number;
}

class DiagramWidget extends WidgetType {
  constructor(
    readonly diagram: EditorDiagram,
    readonly render: DiagramRenderer,
    private readonly size: { measurement?: DiagramMeasurement } = {}
  ) { super(); }

  override eq(other: DiagramWidget) {
    return this.diagram.from === other.diagram.from && this.diagram.to === other.diagram.to &&
      this.render === other.render && this.sameContent(other.diagram);
  }

  private sameContent(other: EditorDiagram) {
    return this.diagram.format === other.format &&
      this.diagram.source === other.source && this.diagram.target === other.target &&
      this.diagram.label === other.label;
  }

  reconcile(diagram: EditorDiagram, render: DiagramRenderer): DiagramWidget {
    if (!this.sameContent(diagram)) return new DiagramWidget(diagram, render);
    if (this.diagram.from === diagram.from && this.diagram.to === diagram.to && this.render === render) return this;
    // Сохраняем измерение, даже если схема сейчас вне DOM.
    return new DiagramWidget(diagram, render, this.size);
  }

  override get estimatedHeight() {
    const size = this.size.measurement;
    const view = size?.view.deref();
    return size && view && size.width === view.contentDOM.clientWidth &&
      size.editorTheme === view.state.facet(EditorView.darkTheme) &&
      (this.diagram.format !== 'mermaid' || size.mermaidTheme === getThemeVersion()) ? size.height : -1;
  }

  private observe(element: HTMLElement, view: EditorView) {
    const viewRef = new WeakRef(view);
    const measure = () => view.requestMeasure({
      key: element,
      read: () => {
        if (!element.isConnected || element.style.minHeight || !ready()) return;
        const height = element.getBoundingClientRect().height;
        const width = view.contentDOM.clientWidth;
        if (height > 0 && width > 0) this.size.measurement = {
          view: viewRef, height, width, editorTheme: view.state.facet(EditorView.darkTheme), mermaidTheme: getThemeVersion()
        };
      }
    });
    const ready = () => element.firstChild !== null && !element.querySelector('[data-diagram-pending]');
    const resize = new ResizeObserver(measure);
    resize.observe(element, { box: 'border-box' });

    // До готовности превью сохраняем высоту вместе с padding.
    const commit = element.style.minHeight ? new MutationObserver(() => {
      if (!ready()) return;
      commit?.disconnect();
      element.style.removeProperty('min-height');
      element.style.removeProperty('box-sizing');
      measure();
    }) : undefined;
    commit?.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-diagram-pending'] });
    observers.set(element, () => { resize.disconnect(); commit?.disconnect(); });
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
    const element = view.contentDOM.ownerDocument.createElement('div');
    element.className = 'lp-diagram';
    element.contentEditable = 'false';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', 'Встроенная диаграмма');
    const height = this.estimatedHeight;
    if (height > 0) {
      element.style.boxSizing = 'border-box';
      element.style.minHeight = `${height}px`;
    }
    this.observe(element, view);
    this.mount(element);
    return element;
  }

  override updateDOM(element: HTMLElement, view: EditorView, previous: DiagramWidget) {
    // При прокрутке CodeMirror может передать контейнер другой схемы.
    // Создаём новый контейнер с высотой текущей схемы до обновления React.
    if (!this.sameContent(previous.diagram)) return false;
    observers.get(element)?.();
    this.observe(element, view);
    this.mount(element);
    return true;
  }

  override destroy(element: HTMLElement) {
    observers.get(element)?.();
    observers.delete(element);
    const root = roots.get(element);
    roots.delete(element);
    queueMicrotask(() => root?.unmount());
  }

  override ignoreEvent() { return true; }
}

function diagramDecorations(state: EditorState, previous = Decoration.none) {
  const render = state.facet(diagramRenderer);
  if (!render) return Decoration.none;
  const widgets = new Map<number, { to: number; widget: DiagramWidget }>();
  previous.between(0, state.doc.length, (from, to, decoration) => {
    const widget: unknown = decoration.spec.widget;
    if (widget instanceof DiagramWidget) widgets.set(from, { to, widget });
  });
  const marks: Range<Decoration>[] = [];
  for (const diagram of parseEditorDiagrams(state.doc)) {
    const entry = widgets.get(diagram.from);
    const widget = entry?.to === diagram.to
      ? entry.widget.reconcile(diagram, render)
      : new DiagramWidget(diagram, render);
    marks.push(Decoration.replace({
      block: true,
      inclusive: false,
      widget
    }).range(diagram.from, diagram.to));
  }
  return Decoration.set(marks, true);
}

export const diagramField = StateField.define<DecorationSet>({
  create: diagramDecorations,
  update(value, transaction) {
    return transaction.docChanged ||
      transaction.startState.facet(diagramRenderer) !== transaction.state.facet(diagramRenderer)
      ? diagramDecorations(transaction.state, value.map(transaction.changes)) : value;
  },
  provide: field => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of(view => view.state.field(field))
  ]
});

// Vim задаёт selection напрямую, минуя atomicRanges. Ни один endpoint не входит в скрытый исходник.
export const diagramSelection = EditorState.transactionFilter.of(transaction => {
  if (!transaction.selection || !transaction.startState.facet(diagramRenderer)) return transaction;
  const diagrams = parseEditorDiagrams(transaction.newDoc);
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
