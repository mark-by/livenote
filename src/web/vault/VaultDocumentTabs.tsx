import { useState } from 'react';
import type { ReactNode } from 'react';
import { CloseButton, Dropdown, Label, Tabs } from '@heroui/react';
import { ArrowLeft, ArrowRight } from '@gravity-ui/icons';
import { copyVaultPath, IconButton } from './VaultControls';
import type { VaultWorkspace } from './useVaultWorkspace';

export function VaultDocumentTabs({ workspace, treeToggle, mainMenu }: {
  readonly workspace: VaultWorkspace;
  readonly treeToggle: ReactNode;
  readonly mainMenu: ReactNode;
}): React.JSX.Element {
  const { openTabs, activeId, snapshot, documents, drafts, history } = workspace;
  const [context, setContext] = useState<{ readonly id: string; readonly x: number; readonly y: number } | null>(null);
  const hasMacTitlebar = '__LIVENOTE_MACOS_TITLEBAR__' in window;
  const contextIndex = context === null ? -1 : openTabs.indexOf(context.id);
  // React Aria требует выбранную вкладку, даже если активная область ещё пуста.
  const selectedTab = activeId ?? openTabs[0];

  const selectTab = (id: string): void => {
    workspace.openPage(id);
    workspace.keepTab(id);
  };

  const runAction = (action: string): void => {
    if (!context || contextIndex < 0) return;
    const { id } = context;
    setContext(null);
    switch (action) {
      case 'close': workspace.closeTab(id); break;
      case 'close-others': workspace.closeTabs(openTabs.filter(tabId => tabId !== id)); break;
      case 'close-left': workspace.closeTabs(openTabs.slice(0, contextIndex)); break;
      case 'close-right': workspace.closeTabs(openTabs.slice(contextIndex + 1)); break;
      case 'split-right': workspace.splitTab(id, 'right'); break;
      case 'split-down': workspace.splitTab(id, 'down'); break;
      case 'copy-path':
        void copyVaultPath(id, workspace.showError);
        break;
    }
  };

  const tabAt = (target: EventTarget): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>('[data-vault-tab]') : null;

  return <div className="vault-tabs-row" data-macos-titlebar={hasMacTitlebar ? '' : undefined}>
    {treeToggle}
    <div className="vault-history" aria-label="История навигации">
      <IconButton label="Назад" icon={ArrowLeft} disabled={history.index <= 0} onPress={workspace.goBack} />
      <IconButton label="Вперёд" icon={ArrowRight} disabled={history.index < 0 || history.index >= history.entries.length - 1} onPress={workspace.goForward} />
    </div>
    <div className="vault-document-tabs" onClickCapture={(event) => {
      if (event.target instanceof Element && event.target.closest('.close-button')) return;
      const id = tabAt(event.target)?.dataset.vaultTab;
      if (id) {
        if (activeId === null && id === selectedTab) selectTab(id);
        else workspace.keepTab(id);
      }
    }} onContextMenu={(event) => {
      const id = tabAt(event.target)?.dataset.vaultTab;
      if (!id) return;
      event.preventDefault();
      setContext({ id, x: event.clientX, y: event.clientY });
    }} onKeyDownCapture={(event) => {
      const tab = tabAt(event.target);
      const id = tab?.dataset.vaultTab;
      if (!tab || !id || event.target !== tab) return;
      if (event.key === 'Enter' || event.key === ' ') {
        if (activeId === null && id === selectedTab) selectTab(id);
        else workspace.keepTab(id);
      }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        const rect = tab.getBoundingClientRect();
        setContext({ id, x: rect.left, y: rect.bottom });
      }
    }}>
    <Tabs aria-label="Открытые документы" selectedKey={selectedTab} onSelectionChange={key => selectTab(key.toString())}>
      <Tabs.ListContainer><Tabs.List aria-label="Открытые документы">{openTabs.map((id) => {
        const title = documents[id]?.page.title ?? snapshot.files.find((file) => file.path === id)?.title ?? id;
        const dirty = drafts[id] && documents[id] && drafts[id].source !== documents[id].source;
        return <Tabs.Tab id={id} key={id} data-vault-tab={id}><span className="vault-tab__label">{title}</span>{dirty && <span className="vault-tab__dirty" aria-label="Есть несохранённые изменения" />}<Tabs.Indicator />
          <CloseButton aria-label={`Закрыть ${title}`} onPress={() => workspace.closeTab(id)} />
        </Tabs.Tab>;
      })}</Tabs.List></Tabs.ListContainer>
    </Tabs>
    </div>
    {hasMacTitlebar && <div className="vault-window-drag" data-tauri-drag-region="" aria-hidden="true" />}
    {mainMenu}
    <Dropdown isOpen={contextIndex >= 0} onOpenChange={(open) => { if (!open) setContext(null); }}>
      <Dropdown.Trigger aria-label="Контекстное меню вкладки" excludeFromTabOrder className="vault-context-anchor"
        style={context ? { left: context.x, top: context.y } : undefined} />
      <Dropdown.Popover><Dropdown.Menu aria-label="Действия вкладки" onAction={(key) => runAction(key.toString())}>
        <Dropdown.Item id="close" textValue="Закрыть"><Label>Закрыть</Label></Dropdown.Item>
        <Dropdown.Item id="close-others" textValue="Закрыть остальные" isDisabled={openTabs.length <= 1}><Label>Закрыть остальные</Label></Dropdown.Item>
        <Dropdown.Item id="close-left" textValue="Закрыть все слева" isDisabled={contextIndex <= 0}><Label>Закрыть все слева</Label></Dropdown.Item>
        <Dropdown.Item id="close-right" textValue="Закрыть все справа" isDisabled={contextIndex >= openTabs.length - 1}><Label>Закрыть все справа</Label></Dropdown.Item>
        <Dropdown.Item id="split-right" textValue="Split Right"><Label>Split Right</Label></Dropdown.Item>
        <Dropdown.Item id="split-down" textValue="Split Down"><Label>Split Down</Label></Dropdown.Item>
        <Dropdown.Item id="copy-path" textValue="Скопировать путь"><Label>Скопировать путь</Label></Dropdown.Item>
      </Dropdown.Menu></Dropdown.Popover>
    </Dropdown>
  </div>;
}
