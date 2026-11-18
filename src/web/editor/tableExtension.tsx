import { Children, isValidElement } from 'react';
import type { ReactNode } from 'react';
import { EditorState, Facet, StateEffect, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { Table } from '@heroui/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownDocument } from './markdownNodes';

export const tableLinkHandler = Facet.define<(target: string) => void, ((target: string) => void) | undefined>({
  combine: values => values[0]
});

const focusChanged = StateEffect.define<boolean>();
const roots = new WeakMap<HTMLElement, Root>();
const observers = new WeakMap<HTMLElement, ResizeObserver>();

function headerChildren(children: ReactNode): ReactNode {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return Children.toArray(child.props.children);
  });
}

function RenderTable({ source, lineOffsets }: { readonly source: string; readonly lineOffsets: readonly number[] }) {
  const cellPosition = (position: { line: number; column: number } | undefined) => {
    if (!position) return 0;
    const lineOffset = lineOffsets[position.line - 1];
    return lineOffset === undefined ? 0 : lineOffset + position.column - 1;
  };
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    table: ({ children }) => <Table><Table.ScrollContainer>
      <Table.Content aria-label="Таблица Markdown">{children}</Table.Content>
    </Table.ScrollContainer></Table>,
    thead: ({ children }) => <Table.Header>{headerChildren(children)}</Table.Header>,
    tbody: ({ children }) => <Table.Body>{children}</Table.Body>,
    tr: ({ children }) => <Table.Row>{children}</Table.Row>,
    th: ({ children, align, node }) => <Table.Column
      isRowHeader={node?.position?.start.offset === 0}
      data-source-pos={cellPosition(node?.position?.start)}
      style={{ textAlign: align === 'char' ? undefined : align ?? undefined }}>{children}</Table.Column>,
    td: ({ children, align, node }) => <Table.Cell
      data-source-pos={cellPosition(node?.position?.start)}
      style={{ textAlign: align === 'char' ? undefined : align ?? undefined }}>{children}</Table.Cell>,
    a: ({ href, children }) => <span role="link" className="lp-link" data-link={href || undefined}>{children}</span>
  }}>{source}</ReactMarkdown>;
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly to: number,
    readonly lineOffsets: readonly number[]
  ) { super(); }

  override eq(other: TableWidget) {
    return this.source === other.source && this.from === other.from && this.to === other.to &&
      this.lineOffsets.length === other.lineOffsets.length &&
      this.lineOffsets.every((offset, index) => offset === other.lineOffsets[index]);
  }

  override toDOM(view: EditorView) {
    const element = document.createElement('div');
    element.className = 'lp-table';
    element.contentEditable = 'false';
    element.tabIndex = 0;
    element.setAttribute('aria-label', 'Таблица Markdown. Нажмите Enter для редактирования');
    element.title = 'Нажмите Enter или выберите ячейку, чтобы изменить Markdown';
    const edit = (position: number) => {
      if (view.state.readOnly) return;
      view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      view.focus();
    };
    element.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLElement>('[data-link]');
      if ((event.metaKey || event.ctrlKey) && link?.dataset.link) {
        view.state.facet(tableLinkHandler)?.(link.dataset.link);
        event.preventDefault();
        return;
      }
      const cell = target.closest<HTMLElement>('[data-source-pos]');
      const offset = Number(cell?.dataset.sourcePos ?? 0);
      edit(Math.min(this.from + offset + 1, this.to));
    });
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        edit(Math.min(this.from + 1, this.to));
      }
    });
    const root = createRoot(element);
    roots.set(element, root);
    root.render(<RenderTable source={this.source} lineOffsets={this.lineOffsets} />);
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(element);
    observers.set(element, observer);
    return element;
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

function decorations(state: EditorState, focused: boolean): DecorationSet {
  const marks: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return;
      const active = focused && !state.readOnly && state.selection.ranges.some(selection =>
        selection.from <= node.to && selection.to >= node.from);
      if (!active) {
        const lines: string[] = [];
        const lineOffsets: number[] = [];
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          if (child.name !== 'TableHeader' && child.name !== 'TableRow' && child.name !== 'TableDelimiter') continue;
          lines.push(state.doc.sliceString(child.from, child.to));
          lineOffsets.push(child.from - node.from);
        }
        const source = lines.join('\n');
        const definitions = markdownDocument(state.doc).definitionSource;
        const markdown = definitions ? `${source}\n\n${definitions}` : source;
        marks.push(Decoration.replace({
          block: true,
          widget: new TableWidget(markdown, node.from, node.to, lineOffsets)
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
      return { focused, decorations: decorations(transaction.state, focused) };
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

export const tableExtension = [
  tableField,
  EditorView.focusChangeEffect.of((_state, focused) => focusChanged.of(focused))
];
