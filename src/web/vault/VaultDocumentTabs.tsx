import { CloseButton, Tabs } from '@heroui/react';
import { ArrowLeft, ArrowRight } from '@gravity-ui/icons';
import { IconButton } from './VaultControls';
import type { VaultWorkspace } from './useVaultWorkspace';

export function VaultDocumentTabs({ workspace }: { workspace: VaultWorkspace }): React.JSX.Element {
  const { openTabs, activeId, snapshot, documents, drafts, history } = workspace;
  return <div className="vault-tabs-row">
    <div className="vault-history" aria-label="История навигации">
      <IconButton label="Назад" icon={ArrowLeft} disabled={history.index <= 0} onPress={workspace.goBack} />
      <IconButton label="Вперёд" icon={ArrowRight} disabled={history.index < 0 || history.index >= history.entries.length - 1} onPress={workspace.goForward} />
    </div>
    <Tabs aria-label="Открытые документы" className="vault-document-tabs" selectedKey={activeId ?? undefined} onSelectionChange={(key) => workspace.openPage(key.toString())}>
      <Tabs.ListContainer><Tabs.List aria-label="Открытые документы">{openTabs.map((id) => {
        const title = documents[id]?.page.title ?? snapshot.files.find((file) => file.path === id)?.title ?? id;
        const dirty = drafts[id] && documents[id] && drafts[id].source !== documents[id].source;
        return <Tabs.Tab id={id} key={id}><span className="vault-tab__label">{title}</span>{dirty && <span className="vault-tab__dirty" aria-label="Есть несохранённые изменения" />}<Tabs.Indicator />
          <CloseButton aria-label={`Закрыть ${title}`} onPress={() => workspace.closeTab(id)} />
        </Tabs.Tab>;
      })}</Tabs.List></Tabs.ListContainer>
    </Tabs>
  </div>;
}
