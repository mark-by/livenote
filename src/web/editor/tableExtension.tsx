import { EditorState, Facet, StateEffect, StateField } from '@codemirror/state';
import type { ChangeSpec, Range } from '@codemirror/state';
import { isolateHistory, redo, undo } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { EditableTable } from './EditableTable';
import { readTable } from './tableSource';
import type { TableSource } from './tableSource';
import { tablePageSize } from './tablePreviewSource';
import type { TablePreviewSource } from './tablePreviewSource';
import { markdownDocument, reuseMarkdownDocument } from './markdownNodes';

export const tableLinkHandler = Facet.define<(target: string) => void, ((target: string) => void) | undefined>({
  combine: values => values[0]
});

const focusChanged = StateEffect.define<boolean>();
const detachedTableLimit = 16;
const detachedCellBudget = 1024;
const detachedSourceLimit = 32 * 1024;

interface MountedTable {
  widget: TableWidget;
  readonly element: HTMLElement;
  readonly root: Root;
  readonly observer: ResizeObserver;
  readonly cache: TableCache | null;
}

const mountedTables = new WeakMap<HTMLElement, MountedTable>();
const tableCache = ViewPlugin.define(view => new TableCache(view));

function unmount(table: MountedTable) {
  mountedTables.delete(table.element);
  queueMicrotask(() => table.root.unmount());
}

class TableCache {
  private readonly detached = new Map<number, MountedTable>();
  private closed = false;

  constructor(private readonly view: EditorView) {}

  private stillPresent(widget: TableWidget): boolean {
    let present = false;
    this.view.state.field(tableField).decorations.between(widget.from, widget.from, (from, to, value) => {
      const current = value.spec.widget;
      if (from === widget.from && to === widget.to && current instanceof TableWidget && current.eq(widget)) {
        present = true;
        return false;
      }
    });
    return present;
  }

  update() {
    for (const [position, table] of this.detached) {
      if (!this.stillPresent(table.widget)) {
        this.detached.delete(position);
        unmount(table);
      }
    }
  }

  take(widget: TableWidget) {
    const table = this.detached.get(widget.from);
    if (!table) return null;
    this.detached.delete(widget.from);
    if (table.widget.eq(widget)) return table;
    unmount(table);
    return null;
  }

  keep(table: MountedTable) {
    const { widget } = table;
    if (this.closed || !widget.canCache || !this.stillPresent(widget)) {
      unmount(table);
      return;
    }
    const position = widget.from;
    const previous = this.detached.get(position);
    if (previous) unmount(previous);
    this.detached.delete(position);
    this.detached.set(position, table);
    let cells = 0;
    for (const cached of this.detached.values()) cells += cached.widget.cellCount;
    for (const [key, cached] of this.detached) {
      if (this.detached.size <= detachedTableLimit && cells <= detachedCellBudget) break;
      this.detached.delete(key);
      cells -= cached.widget.cellCount;
      unmount(cached);
    }
  }

  destroy() {
    this.closed = true;
    for (const table of this.detached.values()) unmount(table);
    this.detached.clear();
  }
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: TablePreviewSource,
    readonly from: number,
    readonly to: number,
    readonly raw: string,
    readonly data: TableSource | null,
    readonly readOnly: boolean
  ) { super(); }

  get cellCount() { return (this.source.rows.length + 1) * this.source.width; }

  get canCache() {
    return this.source.rows.length <= tablePageSize(this.source.width) &&
      this.cellCount <= detachedCellBudget && this.raw.length + this.source.definitions.length <= detachedSourceLimit;
  }

  override eq(other: TableWidget) {
    return this.source.definitions === other.source.definitions && this.from === other.from && this.to === other.to &&
      this.raw === other.raw && this.readOnly === other.readOnly &&
      this.data?.rows[0]?.prefix === other.data?.rows[0]?.prefix;
  }

  override toDOM(view: EditorView) {
    const cache = view.plugin(tableCache);
    const cached = cache?.take(this);
    if (cached) {
      cached.observer.observe(cached.element, { box: 'border-box' });
      return cached.element;
    }

    const element = view.contentDOM.ownerDocument.createElement('div');
    element.className = 'lp-table';
    element.contentEditable = 'false';
    const root = createRoot(element);
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(element, { box: 'border-box' });
    const table = { widget: this, element, root, observer, cache };
    mountedTables.set(element, table);
    this.render(table, view);
    return element;
  }

  override updateDOM(element: HTMLElement, view: EditorView) {
    const table = mountedTables.get(element);
    if (!table) return false;
    table.widget = this;
    this.render(table, view);
    return true;
  }

  private render(mounted: MountedTable, view: EditorView) {
    // Выходим из текущего вызова React, но заполняем блок до следующей отрисовки браузера.
    queueMicrotask(() => {
      if (!mountedTables.has(mounted.element) || mounted.widget !== this) return;
      const applyChanges = (table: TableSource, changes: ChangeSpec) => {
        if (!mounted.element.isConnected || mounted.widget.data !== table || view.state.readOnly ||
          view.state.doc.sliceString(this.from, this.to) !== this.raw) return;
        const changeSet = view.state.changes(changes);
        if (!changeSet.empty) view.dispatch({ changes: changeSet, annotations: isolateHistory.of('full') });
      };
      flushSync(() => mounted.root.render(<EditableTable source={this.source} table={this.data} readOnly={this.readOnly}
        onChange={applyChanges} onLink={href => view.state.facet(tableLinkHandler)?.(href)}
        onHistory={isRedo => { if (!view.state.readOnly) (isRedo ? redo : undo)(view); }} />));
    });
  }

  override destroy(element: HTMLElement) {
    const table = mountedTables.get(element);
    if (!table) return;
    table.observer.disconnect();
    // CodeMirror удаляет блок за пределами окна, но при возврате таблица нужна сразу.
    if (table.cache && !element.querySelector('.lp-table-input, [data-menu-open]')) table.cache.keep(table);
    else unmount(table);
  }

  override ignoreEvent() { return true; }
}

function decorations(state: EditorState, focused: boolean): DecorationSet {
  const marks: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return;
      const active = focused && !state.readOnly && state.selection.ranges.some(selection =>
        selection.from <= node.to && selection.to >= node.from);
      if (!active) {
        let header = '';
        let delimiter = '';
        const rows: string[] = [];
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          if (child.name === 'TableHeader') header = state.doc.sliceString(child.from, child.to);
          else if (child.name === 'TableDelimiter') delimiter = state.doc.sliceString(child.from, child.to);
          else if (child.name === 'TableRow') rows.push(state.doc.sliceString(child.from, child.to));
        }
        if (!header || !delimiter) return false;
        const data = readTable(state.doc, node.node);
        const width = data?.width ?? Math.max(1, delimiter.match(/-+/g)?.length ?? 0);
        const definitions = markdownDocument(state.doc).definitionSource;
        const source = { header, delimiter, rows, width, definitions };
        const raw = state.doc.sliceString(node.from, node.to);
        marks.push(Decoration.replace({
          block: true,
          widget: new TableWidget(source, node.from, node.to, raw, data, state.readOnly)
        }).range(node.from, node.to));
      }
      return false;
    }
  });
  return Decoration.set(marks, true);
}

const tableField = StateField.define<{ readonly focused: boolean; readonly decorations: DecorationSet }>({
  create: state => ({ focused: false, decorations: decorations(state, false) }),
  update(value, transaction) {
    let focused = value.focused;
    for (const effect of transaction.effects) {
      if (effect.is(focusChanged)) focused = effect.value;
    }
    if (transaction.docChanged || transaction.selection || focused !== value.focused ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state) ||
      transaction.startState.readOnly !== transaction.state.readOnly) {
      reuseMarkdownDocument(transaction);
      return { focused, decorations: decorations(transaction.state, focused) };
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

export const tableExtension = [
  tableCache,
  tableField,
  EditorView.focusChangeEffect.of((_state, focused) => focusChanged.of(focused))
];
