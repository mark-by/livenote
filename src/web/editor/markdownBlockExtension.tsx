import { syntaxTree } from '@codemirror/language';
import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { Separator } from '@heroui/react';
import { createRoot } from 'react-dom/client';
import { detailsBody, detailsRanges } from './detailsSource';
import type { DetailsSource } from './detailsSource';
import { MarkdownDetails } from './MarkdownDetails';
import { tableLinkHandler } from './tableExtension';
import type { SourceRange } from './types';

const focusChanged = StateEffect.define<boolean>();
const mounts = new WeakMap<HTMLElement, () => void>();

class MarkdownBlockWidget extends WidgetType {
  constructor(
    readonly range: SourceRange,
    readonly details?: DetailsSource,
    readonly source = '',
  ) { super(); }

  override eq(other: MarkdownBlockWidget) {
    return this.range.from === other.range.from && this.range.to === other.range.to &&
      this.source === other.source && this.details?.summary === other.details?.summary &&
      this.details?.open === other.details?.open && this.details?.bodyFrom === other.details?.bodyFrom &&
      this.details?.bodyIndent === other.details?.bodyIndent;
  }

  override toDOM(view: EditorView) {
    const element = view.contentDOM.ownerDocument.createElement('div');
    element.className = this.details ? 'py-1' : 'py-2';
    element.contentEditable = 'false';
    const root = createRoot(element);
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(element);
    mounts.set(element, () => {
      observer.disconnect();
      queueMicrotask(() => root.unmount());
    });

    const edit = (position: number) => {
      if (view.state.readOnly || !element.isConnected) return;
      view.focus();
      view.dispatch({ selection: { anchor: position }, effects: focusChanged.of(true), scrollIntoView: true });
    };
    const details = this.details;
    if (details) element.dataset.spoilerFrom = String(details.from);
    element.addEventListener('mousedown', event => {
      if (event.button !== 0 || (details && event.target !== element)) return;
      event.preventDefault();
      if (!details) edit(this.range.from);
    });
    const onLink = view.state.facet(tableLinkHandler);
    root.render(details
      ? <MarkdownDetails summary={details.summary} source={detailsBody(this.source, details.bodyIndent)} open={details.open}
          onLink={onLink} />
      : <Separator />);
    return element;
  }

  override destroy(element: HTMLElement) {
    mounts.get(element)?.();
    mounts.delete(element);
  }
}

function isActive(state: EditorState, focused: boolean, range: SourceRange) {
  return focused && !state.readOnly && state.selection.ranges.some(selection =>
    selection.from <= range.to && selection.to >= range.from);
}

function decorations(state: EditorState, focused: boolean) {
  const marks: Range<Decoration>[] = [];
  const details = detailsRanges(state.doc);
  const previews = details.filter(block => !isActive(state, focused, block));
  for (const [index, block] of previews.entries()) {
    const next = previews[index + 1];
    // Компактный зазор заменяет не больше одной разделительной строки.
    const joinsNext = next !== undefined && /^\n(?:[ \t]*\r?\n)?$/.test(state.doc.sliceString(block.to, next.from));
    marks.push(Decoration.replace({
      block: true,
      // На границах виджета не должно быть фиктивных строк для курсора.
      inclusive: true,
      widget: new MarkdownBlockWidget(block, block, state.doc.sliceString(block.bodyFrom, block.bodyTo)),
    }).range(block.from, joinsNext ? next.from - 1 : block.to));
  }
  syntaxTree(state).iterate({
    enter({ from, to, name }) {
      if (name !== 'HorizontalRule' || details.some(block => block.from <= from && to <= block.to)) return;
      const line = state.doc.lineAt(from);
      const range = { from: line.from, to: line.to };
      if (isActive(state, focused, range) || !/^ {0,3}$/.test(state.doc.sliceString(line.from, from))) return;
      marks.push(Decoration.replace({
        block: true,
        inclusive: false,
        widget: new MarkdownBlockWidget(range),
      }).range(range.from, range.to));
    },
  });
  return Decoration.set(marks, true);
}

const blocksField = StateField.define({
  create: state => ({ focused: false, decorations: decorations(state, false) }),
  update(value, transaction) {
    let focused = value.focused;
    for (const effect of transaction.effects) {
      if (effect.is(focusChanged)) focused = effect.value;
    }
    return transaction.docChanged || transaction.selection || focused !== value.focused ||
      transaction.startState.readOnly !== transaction.state.readOnly ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      ? { focused, decorations: decorations(transaction.state, focused) } : value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

export const markdownBlockExtension = [
  blocksField,
  EditorView.focusChangeEffect.of((_state, focused) => focusChanged.of(focused)),
];
