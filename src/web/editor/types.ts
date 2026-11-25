import type { ReactNode, Ref } from 'react';

export type SourceRange = {
  readonly from: number;
  readonly to: number;
};

export type EditorDiagram = SourceRange & {
  readonly format: 'mermaid' | 'bpmn' | 'drawio';
  readonly source: string;
  readonly target?: string;
  readonly label?: string;
};

export type EditorContext = SourceRange & {
  readonly clientX: number;
  readonly clientY: number;
  readonly diagram?: EditorDiagram;
};

export type DiagramRenderer = (diagram: EditorDiagram) => ReactNode;
export type EditorVimMode = 'normal' | 'insert' | 'visual';

export type LivePreviewEditorHandle = {
  readonly focus: () => void;
  readonly revealPosition: (position: number) => void;
  readonly revealLine: (line: number) => void;
  readonly getSelection: () => SourceRange;
  readonly replaceRange: (range: SourceRange, text: string, options?: { readonly focus?: boolean }) => void;
};

export type LivePreviewEditorProps = {
  readonly source: string;
  readonly onChange: (source: string) => void;
  readonly renderDiagram: DiagramRenderer;
  readonly vimEnabled?: boolean;
  readonly onVimModeChange?: (mode: EditorVimMode) => void;
  readonly theme?: 'light' | 'dark';
  readonly ariaLabel?: string;
  readonly onSave?: () => void;
  readonly onContextMenu?: (context: EditorContext) => void;
  readonly onSelectionChange?: (range: SourceRange) => void;
  readonly onOpenLink?: (target: string) => void;
  readonly readOnly?: boolean;
  readonly ref?: Ref<LivePreviewEditorHandle>;
};
