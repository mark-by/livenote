import type { ReactNode, Ref } from 'react';
import type { AgentElementRef, DiagramFormat, WriteLayout } from '../../shared/types';

export interface DiagramValue {
  readonly format: DiagramFormat;
  readonly source: string;
  readonly title?: string;
}

export interface DiagramSession {
  readonly value: DiagramValue;
  readonly mode: 'create' | 'edit' | 'view';
  readonly key: string;
}

export interface DiagramPreviewProps {
  readonly value: DiagramValue;
  readonly onExpand: () => void;
  readonly onEdit: () => void;
  readonly onRemove?: () => void;
  readonly onRename?: (title: string, focusEditor: boolean) => string | undefined;
  readonly persisted?: { readonly pageId: string; readonly blockId: string; readonly revision: number };
}

export interface DiagramAgentEditor {
  /** Считывает выделение синхронно, до завершения текущего ввода и выгрузки исходника. */
  capture(): { selected: AgentElementRef[]; source: Promise<string> };
}

export interface DiagramAgentProps {
  readonly agentPanel?: ReactNode;
  readonly agentEditorRef?: Ref<DiagramAgentEditor>;
  readonly agentLocked?: boolean;
}

export const agentDialogLayout = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gridTemplateRows: 'minmax(0, 1fr)' };

export interface DiagramDialogProps extends DiagramAgentProps {
  readonly session: DiagramSession;
  readonly onSave: (value: DiagramValue, options?: { layout?: WriteLayout }) => Promise<void>;
  readonly onCancel: () => void;
  readonly persisted?: DiagramPreviewProps['persisted'];
}

export type DiagramCommit = (source: string, options?: { layout?: WriteLayout }) => Promise<void>;
