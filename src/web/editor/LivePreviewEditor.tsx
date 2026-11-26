import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter } from '@lezer/highlight';
import { vim, getCM } from '@replit/codemirror-vim';
import { markdownDecorations } from './markdownDecorations';
import { markdownBlockExtension } from './markdownBlockExtension';
import { detailsRanges } from './detailsSource';
import { diagramField, diagramRenderer, diagramSelection } from './diagramExtension';
import { parseEditorDiagrams } from './parseDiagrams';
import { parseEditorLinks } from './parseLinks';
import { tableExtension, tableLinkHandler } from './tableExtension';
import { stableViewport } from './stableViewport';
import type { EditorVimMode, LivePreviewEditorProps } from './types';
import { propertiesExtension, registerPropertiesSave } from './propertiesExtension';
import { readProperties } from './frontmatterProperties';
import './livePreview.css';

const codeLanguageAliases = new Map([
  ['golang', 'go'],
  ['jsonc', 'json'],
  ['zsh', 'sh'],
]);

function codeLanguage(info: string): LanguageDescription | null {
  const name = info.trim().toLowerCase().split(/\s+/, 1)[0];
  if (!name) return null;
  const alias = codeLanguageAliases.get(name) ?? name;
  return LanguageDescription.matchLanguageName(languages, alias, false) ??
    LanguageDescription.matchFilename(languages, `code.${alias}`);
}

export function LivePreviewEditor(props: LivePreviewEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(props);
  current.current = props;
  const [compartments] = useState(() => ({
    vim: new Compartment(),
    diagrams: new Compartment(),
    theme: new Compartment(),
    readOnly: new Compartment(),
    properties: new Compartment(),
  }));

  useImperativeHandle(props.ref, () => ({
    focus: () => view.current?.focus(),
    revealPosition(position) {
      view.current?.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) });
    },
    revealLine(line) {
      const editor = view.current;
      if (!editor) return;
      const doc = editor.state.doc;
      const position = doc.line(Math.min(line, doc.lines)).from;
      editor.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) });
    },
    getSelection() {
      const selection = view.current?.state.selection.main;
      return { from: selection?.from ?? 0, to: selection?.to ?? 0 };
    },
    selectRange(range) {
      const editor = view.current;
      if (!editor || editor.state.readOnly) return;
      editor.focus();
      editor.dispatch({ selection: { anchor: range.from, head: range.to }, scrollIntoView: true });
    },
    replaceRange(range, text, options) {
      const editor = view.current;
      if (!editor) return;
      const focus = options?.focus !== false;
      editor.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length },
        userEvent: 'input',
        scrollIntoView: focus
      });
      if (focus) editor.focus();
    }
  }), []);

  useEffect(() => {
    if (!host.current) return;
    const initial = current.current.documentProperties ? readProperties(current.current.source) : null;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: current.current.source,
        ...(initial?.kind === 'valid' ? { selection: { anchor: Math.min(initial.end + 1, initial.source.length) } } : {}),
        extensions: [
          // Не отбрасываем CR: позиции редактора должны совпадать со смещениями в исходнике.
          current.current.documentProperties ? EditorState.lineSeparator.of('\n') : [],
          compartments.vim.of([]),
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          stableViewport,
          markdown({ base: markdownLanguage, codeLanguages: codeLanguage }),
          syntaxHighlighting(classHighlighter),
          markdownDecorations,
          compartments.properties.of(current.current.documentProperties ? propertiesExtension : []),
          markdownBlockExtension,
          tableExtension,
          tableLinkHandler.of(target => current.current.onOpenLink?.(target)),
          diagramField,
          diagramSelection,
          compartments.diagrams.of(diagramRenderer.of(current.current.renderDiagram)),
          compartments.theme.of([]),
          compartments.readOnly.of([]),
          EditorView.contentAttributes.of({ 'aria-label': current.current.ariaLabel ?? 'Текст заметки' }),
          EditorView.domEventHandlers({
            mousedown(event, editor) {
              if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
              const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
              const callback = current.current.onOpenLink;
              if (position === null || !callback) return false;
              const link = parseEditorLinks(editor.state.doc)
                .find(range => position >= range.from && position <= range.to);
              if (!link) return false;
              callback(link.target);
              event.preventDefault();
              return true;
            }
          }),
          keymap.of([
            { key: 'Mod-Enter', run: editor => {
              const callback = current.current.onOpenLink;
              if (!callback) return false;
              const position = editor.state.selection.main.head;
              const link = parseEditorLinks(editor.state.doc)
                .find(range => position >= range.from && position <= range.to);
              if (!link) return false;
              callback(link.target);
              return true;
            } },
            { key: 'Mod-s', run: () => { current.current.onSave?.(); return true; } },
            ...markdownKeymap, ...defaultKeymap, ...historyKeymap
          ]),
          EditorView.updateListener.of(update => {
            if (update.docChanged) current.current.onChange(update.state.sliceDoc());
            if (update.selectionSet || update.docChanged) {
              const { from, to } = update.state.selection.main;
              current.current.onSelectionChange?.({ from, to });
            }
          })
        ]
      })
    });
    registerPropertiesSave(editor, () => current.current.onSave?.());
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [compartments]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (editor.state.sliceDoc() === props.source) return;
    const previous = editor.state.doc.toString();
    const nextText = editor.state.toText(props.source);
    const next = nextText.toString();
    let from = 0;
    let oldEnd = previous.length;
    let newEnd = next.length;
    while (from < oldEnd && from < newEnd && previous[from] === next[from]) from++;
    while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === next[newEnd - 1]) {
      oldEnd--; newEnd--;
    }
    editor.dispatch({
      changes: { from, to: oldEnd, insert: nextText.slice(from, newEnd) },
      annotations: Transaction.addToHistory.of(false),
      userEvent: 'sync.source',
    });
  }, [props.source]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.facet(diagramRenderer) === props.renderDiagram) return;
    editor.dispatch({
      effects: compartments.diagrams.reconfigure(diagramRenderer.of(props.renderDiagram))
    });
  }, [props.renderDiagram, compartments]);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.readOnly.reconfigure([
        EditorState.readOnly.of(props.readOnly ?? false),
        EditorView.editable.of(!props.readOnly)
      ])
    });
  }, [props.readOnly, compartments]);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.properties.reconfigure(props.documentProperties ? propertiesExtension : [])
    });
  }, [props.documentProperties, compartments]);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.theme.reconfigure(EditorView.darkTheme.of(props.theme === 'dark'))
    });
  }, [props.theme, compartments]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const selection = editor.state.selection;
    editor.dispatch({ effects: compartments.vim.reconfigure(props.vimEnabled ? vim({ status: false }) : []) });
    if (!editor.state.selection.eq(selection)) editor.dispatch({ selection });
    const cm = getCM(editor);
    const updateMode = () => {
      const state = cm?.state.vim;
      const next: EditorVimMode = state?.insertMode ? 'insert' : state?.visualMode ? 'visual' : 'normal';
      current.current.onVimModeChange?.(next);
    };
    if (props.vimEnabled && cm) {
      updateMode();
      cm.on('vim-mode-change', updateMode);
      return () => cm.off('vim-mode-change', updateMode);
    }
    current.current.onVimModeChange?.('normal');
  }, [props.vimEnabled, compartments]);

  return (
    <div className="live-preview-editor" onContextMenu={event => {
      const editor = view.current;
      const callback = props.onContextMenu;
      if (!editor || !callback || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, .lp-properties')) return;
      const widget = target instanceof Element ? target.closest<HTMLElement>('.lp-diagram') : null;
      const spoilerWidget = target instanceof Element ? target.closest<HTMLElement>('[data-spoiler-from]') : null;
      const spoiler = spoilerWidget && detailsRanges(editor.state.doc)
        .find(range => range.from === Number(spoilerWidget.dataset.spoilerFrom));
      const spoilerSummary = spoiler && (
        spoiler.summaryRange ?? { from: spoiler.bodyFrom, to: spoiler.bodyFrom }
      );
      const position = widget ? Number(widget.dataset.from) :
        editor.posAtCoords({ x: event.clientX, y: event.clientY }, false);
      const diagram = widget ? parseEditorDiagrams(editor.state.doc)
        .find(range => range.from === position && range.to === Number(widget.dataset.to)) : undefined;
      callback({
        from: diagram?.from ?? spoiler?.from ?? position, to: diagram?.to ?? spoiler?.to ?? position,
        clientX: event.clientX, clientY: event.clientY,
        ...(diagram ? { diagram } : {}),
        ...(spoilerSummary ? { spoilerSummary } : {}),
      });
      event.preventDefault();
    }}>
      <div className="lp-host" ref={host} />
    </div>
  );
}

export type {
  EditorContext, EditorDiagram, EditorVimMode, LivePreviewEditorHandle, LivePreviewEditorProps, SourceRange
} from './types';
