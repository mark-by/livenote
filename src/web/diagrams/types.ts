import type { DiagramFormat, WriteLayout } from '../../shared/types';

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
  readonly persisted?: { readonly pageId: string; readonly blockId: string; readonly revision: number };
}

export interface DiagramDialogProps {
  readonly session: DiagramSession;
  readonly onSave: (value: DiagramValue, options?: { layout?: WriteLayout }) => Promise<void>;
  readonly onCancel: () => void;
  readonly persisted?: DiagramPreviewProps['persisted'];
}

export type DiagramCommit = (source: string, options?: { layout?: WriteLayout }) => Promise<void>;
