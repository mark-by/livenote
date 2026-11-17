import { StateField } from '@codemirror/state';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNodeRef } from '@lezer/common';
import { parseEditorDiagrams } from './parseDiagrams';
import { parseEditorLinks } from './parseLinks';

class ListMarkerWidget extends WidgetType {
  constructor(readonly label: string) { super(); }
  override eq(other: ListMarkerWidget) { return this.label === other.label; }
  override toDOM() {
    const span = document.createElement('span');
    span.className = 'lp-list-marker';
    span.textContent = this.label;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

function active(state: EditorState, range: { readonly from: number; readonly to: number }) {
  return state.selection.ranges.some(selection =>
    selection.from <= range.to && selection.to >= range.from);
}

function decorations(state: EditorState): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  const diagrams = parseEditorDiagrams(state.doc.toString());
  const links = parseEditorLinks(state.doc.toString());
  const wikiLinks = links.filter(link => link.wiki);
  for (const link of links) {
    marks.push(Decoration.mark({
      class: 'lp-link', attributes: { role: 'link', title: 'Открыть: Ctrl/Cmd + клик или Ctrl/Cmd + Enter' }
    }).range(link.from, link.to));
  }
  for (const link of wikiLinks) {
    if (active(state, link)) continue;
    marks.push(Decoration.replace({}).range(link.from, link.labelFrom));
    marks.push(Decoration.replace({}).range(link.labelTo, link.to));
  }
  tree.iterate({
    enter(node: SyntaxNodeRef) {
      const { from, to, name } = node;
      if (diagrams.some(range => range.from <= from && range.to >= to)) return false;
      if (wikiLinks.some(range => range.from <= from && range.to >= to)) return false;
      if (/^(ATXHeading|SetextHeading)\d$/.test(name)) {
        const level = name.slice(-1);
        const line = state.doc.lineAt(from);
        marks.push(Decoration.line({
          attributes: { class: `lp-heading lp-heading-${level}`, role: 'heading', 'aria-level': level }
        }).range(line.from));
      }
      let className: string | undefined;
      switch (name) {
        case 'StrongEmphasis': className = 'lp-strong'; break;
        case 'Emphasis': className = 'lp-emphasis'; break;
        case 'Strikethrough': className = 'lp-strike'; break;
        case 'InlineCode': className = 'lp-code'; break;
      }
      if (className) marks.push(Decoration.mark({ class: className }).range(from, to));
      if (name === 'FencedCode' || name === 'CodeBlock') {
        for (let pos = state.doc.lineAt(from).from; pos <= to;) {
          marks.push(Decoration.line({ class: 'lp-code-line' }).range(pos));
          const line = state.doc.lineAt(pos);
          if (line.to === state.doc.length) break;
          pos = line.to + 1;
        }
      }
      if (name === 'ListItem' || name === 'Blockquote') {
        for (let pos = state.doc.lineAt(from).from; pos < to;) {
          marks.push(Decoration.line({ class: name === 'ListItem' ? 'lp-list-item' : 'lp-quote' }).range(pos));
          const line = state.doc.lineAt(pos);
          if (line.to === state.doc.length) break;
          pos = line.to + 1;
        }
      }
      if (name === 'ListMark') {
        const parent = node.node.parent;
        const label = state.doc.sliceString(from, to);
        if (parent && !active(state, parent)) marks.push(Decoration.replace({
          widget: new ListMarkerWidget(/^\d/.test(label) ? label : '•')
        }).range(from, to));
        else marks.push(Decoration.mark({ class: 'lp-marker lp-list-marker' }).range(from, to));
      }
      if (name === 'QuoteMark') {
        const line = state.doc.lineAt(from);
        if (!active(state, line)) {
          const end = state.doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
          marks.push(Decoration.replace({}).range(from, end));
        } else marks.push(Decoration.mark({ class: 'lp-marker' }).range(from, to));
      }
      if (/^(HeaderMark|EmphasisMark|CodeMark|StrikethroughMark|LinkMark)$/.test(name)) {
        const parent = node.node.parent;
        if (parent && !active(state, parent)) {
          const end = name === 'HeaderMark' && state.doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
          marks.push(Decoration.replace({}).range(from, end));
        } else {
          marks.push(Decoration.mark({ class: 'lp-marker' }).range(from, to));
        }
      }
      if (name === 'URL' && node.node.parent?.name === 'Link') {
        const parent = node.node.parent;
        if (!active(state, parent)) marks.push(Decoration.replace({}).range(from, to));
      }
    }
  });
  return Decoration.set(marks, true);
}

export const markdownDecorations = StateField.define<DecorationSet>({
  create: decorations,
  update(value, transaction) {
    return transaction.docChanged || transaction.selection ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      ? decorations(transaction.state) : value;
  },
  provide: field => EditorView.decorations.from(field)
});
