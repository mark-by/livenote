import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { CloseButton } from '@heroui/react';
import type { EditorVimMode } from '../editor/LivePreviewEditor';
import { VaultDocumentLoading, VaultDocumentView } from './VaultDocumentView';
import { VaultEditorStatus } from './VaultEditorStatus';
import { VaultPaneDivider } from './VaultPaneDivider';
import type { VaultWorkspace } from './useVaultWorkspace';
import { positionPaneLayout } from './vaultPaneState';
import type { PositionedPane } from './vaultPaneState';
import { fileStem, formatForPath } from './vaultPaths';
import './vaultPaneResize.css';

function VaultPaneFrame({ pane, workspace, title, visible = true, children }: {
  readonly pane?: PositionedPane;
  readonly workspace: VaultWorkspace;
  readonly title: string;
  readonly visible?: boolean;
  readonly children: ReactNode;
}): React.JSX.Element {
  const style: CSSProperties | undefined = pane && {
    left: `${pane.x}%`, top: `${pane.y}%`, width: `${pane.width}%`, height: `${pane.height}%`,
    borderInlineStartWidth: pane.x === 0 ? 0 : 1, borderBlockStartWidth: pane.y === 0 ? 0 : 1
  };
  const focused = pane !== undefined && workspace.paneLayout?.focused === pane.id;
  const activate = (event: React.SyntheticEvent<HTMLDivElement>): void => {
    if (pane && !focused && event.target instanceof Node && event.currentTarget.contains(event.target)) {
      workspace.focusPane(pane.id);
    }
  };
  return <div className="vault-editor-frame" style={style} hidden={!visible} data-split={pane ? '' : undefined}
    data-focused={focused ? '' : undefined} onPointerDownCapture={event => { if (event.button === 0) activate(event); }} onFocusCapture={activate}>
    {pane ? <div className="vault-editor-frame__bar">
      <span title={title}>{title}</span>
      <CloseButton aria-label="Закрыть область редактора" onPress={() => workspace.closePane(pane.id)} />
    </div> : null}
    <div className="vault-editor-frame__body">{children}</div>
  </div>;
}

export function VaultEditors({ workspace, theme, vimEnabled, onRevealFolder, agentPanel }: {
  readonly workspace: VaultWorkspace;
  readonly theme: 'light' | 'dark';
  readonly vimEnabled: boolean;
  readonly onRevealFolder: (path: string) => void;
  readonly agentPanel?: ReactNode;
}): React.JSX.Element {
  const { activeId, paneLayout } = workspace;
  const [vimModes, setVimModes] = useState<ReadonlyMap<string, EditorVimMode>>(() => new Map());
  const { panes, splits } = positionPaneLayout(paneLayout?.root);
  const paneByPath = new Map(panes.map(pane => [pane.path, pane]));
  const activeDocument = activeId === null ? undefined : workspace.documents[activeId];
  return <main className="vault-main">
    <div className="vault-editor-area">
      {workspace.openTabs.map(path => {
        const document = workspace.documents[path];
        const pane = paneByPath.get(path);
        const visible = paneLayout ? pane !== undefined : path === activeId;
        const title = document?.page.title ?? fileStem(path);
        // Один ключ на файл: разделение и переключение областей не пересоздают редактор.
        return <VaultPaneFrame key={path} workspace={workspace} pane={pane} title={title} visible={visible}>
          {document ? <VaultDocumentView workspace={workspace} document={document} active={visible} theme={theme}
            agentPanel={workspace.agentDiagramPath === path ? agentPanel : undefined}
            vimEnabled={vimEnabled} onRevealFolder={onRevealFolder} onVimModeChange={mode => setVimModes(previous => {
              if ((previous.get(path) ?? 'normal') === mode) return previous;
              const next = new Map(previous);
              if (mode === 'normal') next.delete(path);
              else next.set(path, mode);
              return next;
            })} /> : pane && <VaultDocumentLoading />}
        </VaultPaneFrame>;
      })}
      {panes.filter(pane => pane.path === null).map(pane =>
        <VaultPaneFrame key={pane.id} workspace={workspace} pane={pane} title="Новая область">
          <div className="vault-welcome vault-editor-empty"><p>Откройте файл из дерева или выберите вкладку.</p></div>
        </VaultPaneFrame>
      )}
      {splits.map(split => <VaultPaneDivider key={split.id} split={split} resize={workspace.resizePaneSplit} />)}
      {workspace.unavailable ? <div className="vault-welcome"><h1>Хранилище недоступно</h1><p>{workspace.unavailable}</p></div>
        : !paneLayout && !activeDocument && (activeId !== null || !workspace.ready ? <VaultDocumentLoading />
          : <div className="vault-welcome"><h1>Начните с заметки</h1><p>Выберите файл слева или создайте Markdown-документ в текущей папке.</p></div>)}
    </div>
    {activeDocument && formatForPath(activeDocument.path) === 'markdown' && <VaultEditorStatus
      key={activeDocument.path} backlinks={activeDocument.backlinks}
      vimMode={vimEnabled ? vimModes.get(activeDocument.path) ?? 'normal' : undefined}
      onNavigate={workspace.openPage} />}
  </main>;
}
