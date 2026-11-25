import { useCallback, useState } from 'react';
import { Alert, Button, Drawer } from '@heroui/react';
import { Bars, FolderOpen, Gear, LayoutSideContentLeft, Moon, Sun } from '@gravity-ui/icons';
import { AgentBindingDialog } from '../agent/AgentBindingDialog';
import { AgentChatPanel } from '../agent/AgentChatPanel';
import { useAgentChat } from '../agent/useAgentChat';
import '../agent/agent.css';
import type { WebApiConfig } from '../api';
import { openVaultFolder, vaultLocationUrl } from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { SettingsDialog } from '../components/SettingsDialog';
import type { PageWidth } from '../components/SettingsDialog';
import { TokenDialog } from '../components/TokenDialog';
import { useShortcuts } from '../useShortcuts';
import { VaultMenu } from './VaultControls';
import { VaultPathDialog } from './VaultDialogs';
import { VaultDocumentTabs } from './VaultDocumentTabs';
import { VaultEditors } from './VaultEditors';
import { VaultSidebar } from './VaultSidebar';
import { VaultWorkspaceLayout } from './VaultWorkspaceLayout';
import { useVaultFolderExpansion } from './useVaultFolderExpansion';
import { useVaultWorkspace } from './useVaultWorkspace';
import { parentPath } from './vaultPaths';

interface PathOperation {
  readonly kind: 'move' | 'move-folder';
  readonly path: string;
}

interface VaultAppProps {
  readonly config: WebApiConfig;
  readonly vaultId: string | null;
  readonly vaultIdExplicit: boolean;
}

export function VaultApp({ config, vaultId, vaultIdExplicit }: VaultAppProps): React.JSX.Element {
  const [treeOpen, setTreeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const [folderPickerPending, setFolderPickerPending] = useState(false);
  const [bindingFolder, setBindingFolder] = useState<string | null>(null);
  const [folderNotice, setFolderNotice] = useState<{ kind: 'pending' | 'error' | 'cancel'; text: string } | null>(null);
  const [operation, setOperation] = useState<PathOperation | null>(null);
  const [pageWidth, setPageWidth] = useState<PageWidth>(() => {
    const saved = localStorage.getItem('livenote_page_width'); return saved === 'wide' || saved === 'full' ? saved : 'standard';
  });
  const [follow, setFollow] = useState(() => localStorage.getItem('livenote_follow') !== '0');
  const workspace = useVaultWorkspace(config.tokenRequired, follow, vaultId, vaultIdExplicit);
  // Чат агента ждет входа: за формой токена его запросы получают 401 и портят панель.
  const agentEnabled = config.agentChat === true && vaultId !== null && !workspace.tokenOpen;
  const agentChat = useAgentChat({ vaultId, workspace, enabled: agentEnabled });
  const setAgentOpen = agentChat.setOpen;
  const toggleAgent = useCallback(() => setAgentOpen(open => !open), [setAgentOpen]);
  useShortcuts({ openSettings, goBack: workspace.goBack, goForward: workspace.goForward,
    toggleAgent: agentEnabled ? toggleAgent : undefined });
  const folderExpansion = useVaultFolderExpansion(vaultId);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('livenote_color_theme') === 'dark' ? 'dark' : 'light');
  const [vimEnabled, setVimEnabled] = useState(() => localStorage.getItem('livenote_vim') === '1');
  const { confirm, dialog } = useConfirm();

  const revealFolder = (path: string): void => {
    const ancestors: string[] = [];
    for (let folder = path; folder; folder = parentPath(folder)) ancestors.push(folder);
    folderExpansion.setFoldersExpanded(ancestors, true);
    workspace.setSelectedFolder(path);
    if (window.matchMedia('(max-width: 50rem)').matches) setTreeOpen(true);
  };

  const changeTheme = (): void => {
    const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next);
    document.documentElement.dataset.theme = next; document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem('livenote_color_theme', next);
  };

  const openFolder = async (): Promise<void> => {
    if (folderPickerPending) return;
    const reservedTab = window.open('about:blank', '_blank');
    if (reservedTab === null) {
      setFolderNotice({ kind: 'error', text: 'Браузер заблокировал новую вкладку. Разрешите всплывающие окна для LiveNote и повторите.' });
      return;
    }
    setFolderPickerPending(true);
    setFolderNotice({ kind: 'pending', text: 'Системный диалог открыт. Текущая вкладка осталась доступной.' });
    try {
      reservedTab.opener = null;
      const result = await openVaultFolder();
      if (result.vault === null) {
        reservedTab.close();
        setFolderNotice({ kind: 'cancel', text: 'Текущая вкладка осталась без изменений.' });
        return;
      }
      reservedTab.location.replace(vaultLocationUrl(result.vault.id));
      setFolderNotice(null);
    } catch (openError) {
      reservedTab.close();
      setFolderNotice({ kind: 'error', text: openError instanceof Error ? openError.message : String(openError) });
    } finally {
      setFolderPickerPending(false);
    }
  };

  const fileAction = async (action: string, path: string): Promise<void> => {
    if (action === 'delete') {
      const document = workspace.documents[path];
      const title = document?.page.title ?? workspace.snapshot.files.find((file) => file.path === path)?.title ?? path;
      if (await confirm({ title: 'Удалить файл?', message: `«${title}» будет удалён окончательно. Ссылки на него останутся в других заметках.`, confirmLabel: 'Удалить', danger: true })) await workspace.removeDocument(path);
    } else setOperation({ kind: 'move', path });
  };

  const folderAction = async (action: string, path: string): Promise<void> => {
    workspace.setSelectedFolder(path);
    if (action === 'binding') {
      setBindingFolder(path);
      return;
    }
    if (action === 'delete') {
      const recursive = workspace.snapshot.files.some((file) => file.path.startsWith(`${path}/`))
        || workspace.snapshot.folders.some((folder) => folder.startsWith(`${path}/`));
      if (await confirm({ title: 'Удалить папку?', message: recursive ? `«${path}» и все вложенные файлы будут удалены окончательно.` : `Пустая папка «${path}» будет удалена окончательно.`, confirmLabel: 'Удалить', danger: true })) await workspace.removeFolder(path, recursive);
      return;
    }
    setOperation({ kind: 'move-folder', path });
  };

  const submitOperation = async (path: string): Promise<string | null> => {
    if (!operation) return null;
    if (operation.kind === 'move-folder') return workspace.moveFolder(operation.path, path);
    return workspace.move(operation.path, path);
  };

  const agentPanel = agentEnabled ? <AgentChatPanel chat={agentChat} workspace={workspace}
    onClose={() => agentChat.setOpen(false)} onOpenSettings={openSettings} /> : undefined;

  return <div className="vault-app" data-page-width={pageWidth}>
    <VaultDocumentTabs workspace={workspace} treeToggle={
      <Button className="vault-mobile-tree vault-icon-button" aria-label="Открыть дерево заметок" variant="ghost" onPress={() => setTreeOpen(true)}><LayoutSideContentLeft aria-hidden="true" /></Button>
    } mainMenu={<VaultMenu label="Меню LiveNote" triggerIcon={Bars} onAction={(action) => {
        if (action === 'open-folder') void openFolder();
        if (action === 'theme') changeTheme();
        if (action === 'settings') openSettings();
      }} actions={[
        ...(config.folderPickerAvailable === true ? [{ id: 'open-folder', label: 'Открыть папку', icon: FolderOpen }] : []),
        { id: 'theme', label: theme === 'dark' ? 'Светлая тема' : 'Тёмная тема', icon: theme === 'dark' ? Sun : Moon },
        { id: 'settings', label: 'Настройки', icon: Gear }
      ]} />} />
    <VaultWorkspaceLayout sidebar={<VaultSidebar workspace={workspace} {...folderExpansion} onFileAction={(action, path) => void fileAction(action, path)} onFolderAction={(action, path) => void folderAction(action, path)} />}
      agentPanel={agentPanel} agentPanelOpen={agentEnabled && agentChat.open && workspace.agentDiagramPath === null}
      agentPanelWidth={agentChat.width} onAgentPanelWidthChange={agentChat.setWidth}>
      <VaultEditors workspace={workspace} theme={theme} vimEnabled={vimEnabled} onRevealFolder={revealFolder}
        agentPanel={agentChat.open ? agentPanel : undefined} agentToggle={agentEnabled ? agentChat : undefined} />
    </VaultWorkspaceLayout>
    <Drawer.Backdrop isOpen={treeOpen} onOpenChange={setTreeOpen}><Drawer.Content placement="left" className="vault-mobile-drawer"><Drawer.Dialog aria-label="Дерево заметок">
      <Drawer.Header><Drawer.Heading>Файлы</Drawer.Heading><Drawer.CloseTrigger aria-label="Закрыть дерево" /></Drawer.Header><Drawer.Body><VaultSidebar workspace={workspace} {...folderExpansion} onNavigate={() => setTreeOpen(false)} onFileAction={(action, path) => void fileAction(action, path)} onFolderAction={(action, path) => void folderAction(action, path)} /></Drawer.Body>
    </Drawer.Dialog></Drawer.Content></Drawer.Backdrop>
    {operation && <VaultPathDialog open title="Переместить" label="Путь" initialPath={operation.path} confirmLabel="Сохранить" onOpenChange={(open) => { if (!open) setOperation(null); }} onSubmit={submitOperation} />}
    {settingsOpen && <SettingsDialog vaultShortcuts pageWidth={pageWidth} onPageWidthChange={(width) => { setPageWidth(width); localStorage.setItem('livenote_page_width', width); }} followEvents={follow} onFollowChange={(value) => { setFollow(value); localStorage.setItem('livenote_follow', value ? '1' : '0'); }} vimEnabled={vimEnabled} onVimEnabledChange={(value) => { setVimEnabled(value); localStorage.setItem('livenote_vim', value ? '1' : '0'); }}
      agent={agentEnabled && vaultId !== null ? {
        vaultId, value: agentChat.contextLimitTokens, onChange: agentChat.setContextLimitTokens,
        search: agentChat.search, onSearchChange: agentChat.setSearch
      } : undefined} onClose={() => setSettingsOpen(false)} />}
    {bindingFolder !== null && vaultId !== null && <AgentBindingDialog vaultId={vaultId} folder={bindingFolder} onClose={() => setBindingFolder(null)} />}
    {workspace.tokenOpen && <TokenDialog onConfirm={workspace.confirmToken} />}
    {folderNotice && <Alert className="vault-global-error" color={folderNotice.kind === 'error' ? 'danger' : 'default'} role={folderNotice.kind === 'error' ? 'alert' : 'status'}><Alert.Content><Alert.Title>{folderNotice.kind === 'error' ? 'Не удалось открыть папку' : folderNotice.kind === 'pending' ? 'Ожидание выбора папки' : 'Выбор папки отменён'}</Alert.Title><Alert.Description>{folderNotice.text}</Alert.Description></Alert.Content>{folderNotice.kind !== 'pending' && <Button size="sm" variant="ghost" onPress={() => setFolderNotice(null)}>Закрыть</Button>}</Alert>}
    {workspace.error && <Alert className="vault-global-error" color="danger" role="alert"><Alert.Content><Alert.Title>Не удалось выполнить действие</Alert.Title><Alert.Description>{workspace.error}</Alert.Description></Alert.Content><Button size="sm" variant="ghost" onPress={workspace.clearError}>Закрыть</Button></Alert>}
    {dialog}
  </div>;
}
