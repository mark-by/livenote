import { isolateHistory, redo, undo } from '@codemirror/commands';
import { EditorSelection, EditorState, Prec, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { DocumentProperties } from './DocumentProperties';
import { editProperty, readProperties } from './frontmatterProperties';
import type { Properties, PropertyEdit } from './frontmatterProperties';

const mounts = new WeakMap<HTMLElement, { readonly root: Root; readonly observer: ResizeObserver }>();
const onSave = new WeakMap<EditorView, () => void>();

export function registerPropertiesSave(view: EditorView, save: () => void) {
  onSave.set(view, save);
}

class PropertiesWidget extends WidgetType {
  constructor(readonly properties: Properties, readonly locked: boolean) { super(); }

  override eq(other: PropertiesWidget) {
    return this.locked === other.locked && this.properties.kind === other.properties.kind &&
      (this.properties.kind !== 'valid' || (other.properties.kind === 'valid' && this.properties.raw === other.properties.raw));
  }

  override toDOM(view: EditorView) {
    const element = view.contentDOM.ownerDocument.createElement('div');
    element.className = 'lp-properties';
    element.contentEditable = 'false';
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(element);
    mounts.set(element, { root: createRoot(element), observer });
    this.updateDOM(element, view);
    return element;
  }

  override updateDOM(element: HTMLElement, view: EditorView) {
    const mounted = mounts.get(element);
    if (!mounted) return false;
    const gesture = (operation: PropertyEdit) => {
      if (!element.isConnected || view.state.readOnly) return;
      const current = view.state.field(propertiesField).properties;
      if (!this.eq(new PropertiesWidget(current, view.state.readOnly))) return;
      const changes = editProperty(current, operation);
      if (changes) view.dispatch({ changes, annotations: isolateHistory.of('full'), userEvent: 'input.properties' });
    };
    mounted.root.render(<DocumentProperties properties={this.properties} locked={this.locked} onEdit={gesture}
      onHistory={forward => { if (!view.state.readOnly) (forward ? redo : undo)(view); }}
      onSave={() => onSave.get(view)?.()} />);
    return true;
  }

  override destroy(element: HTMLElement) {
    const mounted = mounts.get(element);
    if (!mounted) return;
    mounts.delete(element);
    mounted.observer.disconnect();
    queueMicrotask(() => mounted.root.unmount());
  }
}

function propertiesState(state: EditorState) {
  const properties = readProperties(state.doc.toString());
  const widget = new PropertiesWidget(properties, state.readOnly);
  const decorations = properties.kind === 'valid'
    ? Decoration.set(Decoration.replace({ widget, block: true, inclusiveEnd: false }).range(0, properties.end))
    : properties.kind === 'missing' && state.readOnly
      ? Decoration.none
      : Decoration.set(Decoration.widget({ widget, block: true, side: -1 }).range(0));
  return { properties, decorations };
}

const propertiesField = StateField.define({
  create: propertiesState,
  update(value, transaction) {
    if (transaction.startState.readOnly !== transaction.state.readOnly || transaction.docChanged) {
      return propertiesState(transaction.state);
    }
    return value;
  },
  provide: field => [
    EditorView.decorations.from(field, value => value.decorations),
    EditorView.atomicRanges.of(view => view.state.field(field).decorations),
  ],
});

const protectProperties = EditorState.changeFilter.of(transaction => {
  const properties = transaction.startState.field(propertiesField).properties;
  if (properties.kind !== 'valid' || transaction.isUserEvent('input.properties') ||
    transaction.isUserEvent('undo') || transaction.isUserEvent('redo') ||
    transaction.isUserEvent('sync.source')) return true;
  const firstBodyPosition = Math.min(transaction.startState.doc.length, properties.end + 1);
  return [-1, firstBodyPosition];
});

const selectBody = EditorState.transactionFilter.of(transaction => {
  if (!transaction.selection) return transaction;
  const selection = transaction.newSelection;
  const properties = transaction.state.field(propertiesField).properties;
  if (properties.kind !== 'valid') return transaction;
  const firstBodyPosition = Math.min(transaction.newDoc.length, properties.end + 1);
  if (selection.ranges.every(range => range.from >= firstBodyPosition)) return transaction;
  const ranges = selection.ranges.map(range => EditorSelection.range(
    Math.max(range.anchor, firstBodyPosition), Math.max(range.head, firstBodyPosition),
  ));
  return [transaction, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }];
});

const startBody = Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
  const properties = view.state.field(propertiesField).properties;
  if (properties.kind !== 'valid' || view.state.readOnly) return false;
  const end = view.state.doc.length;
  if (properties.end !== end) return false;
  // В файле без тела пока нет перевода строки после закрывающего маркера.
  const insert = properties.newline + text;
  view.dispatch({ changes: { from: end, insert }, selection: { anchor: end + insert.length },
    userEvent: 'input.properties.body' });
  return true;
}));

export const propertiesExtension = [propertiesField, protectProperties, selectBody, startBody];
