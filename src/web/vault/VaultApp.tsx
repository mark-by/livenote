import { useRef, useState } from 'react';
import { Alert, Button, Drawer } from '@heroui/react';
import { ArrowDownToSquare, ArrowUpFromSquare, Bars, FolderOpen, Gear, LayoutSideContentLeft, Moon, Sun } from '@gravity-ui/icons';
import type { WebApiConfig } from '../api';
import { exportAll, exportPage, importMarkdown, openVaultFolder, vaultLocationUrl } from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { SettingsDialog } from '../components/SettingsDialog';
import type { PageWidth } from '../components/SettingsDialog';
import { TokenDialog } from '../components/TokenDialog';
import { VaultMenu } from './VaultControls';
import { DiagnosticsDialog, VaultPathDialog } from './VaultDialogs';
import { VaultDocumentTabs } from './VaultDocumentTabs';
import { VaultEditors } from './VaultEditors';
import { VaultSidebar } from './VaultSidebar';
import { VaultWorkspaceLayout } from './VaultWorkspaceLayout';
import { useVaultFolderExpansion } from './useVaultFolderExpansion';
import { useVaultWorkspace } from './useVaultWorkspace';
import { fileStem, parentPath } from './vaultPaths';

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
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [folderPickerPending, setFolderPickerPending] = useState(false);
  const [folderNotice, setFolderNotice] = useState<{ kind: 'pending' | 'error' | 'cancel'; text: string } | null>(null);
  const [operation, setOperation] = useState<PathOperation | null>(null);
  const [pageWidth, setPageWidth] = useState<PageWidth>(() => {
    const saved = localStorage.getItem('livenote_page_width'); return saved === 'wide' || saved === 'full' ? saved : 'standard';
  });
  const [follow, setFollow] = useState(() => localStorage.getItem('livenote_follow') !== '0');
  const workspace = useVaultWorkspace(config.tokenRequired, follow, vaultId, vaultIdExplicit);
  const folderExpansion = useVaultFolderExpansion(vaultId);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('livenote_color_theme') === 'dark' ? 'dark' : 'light');
  const [vimEnabled, setVimEnabled] = useState(() => localStorage.getItem('livenote_vim') === '1');
  const fileRef = useRef<HTMLInputElement>(null);
  const { confirm, dialog } = useConfirm();
  const activeDocument = workspace.activeId ? workspace.documents[workspace.activeId] : undefined;

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

  const importFile = async (file: File): Promise<void> => {
    try {
      const page = await importMarkdown({ title: fileStem(file.name), content: await file.text() });
      workspace.openPage(page.id); await workspace.reload(page.id); await workspace.refresh();
    } catch (error) { workspace.showError(error instanceof Error ? error.message : String(error)); }
  };

  return <div className="vault-app" data-page-width={pageWidth}>
    <VaultDocumentTabs workspace={workspace} treeToggle={
      <Button className="vault-mobile-tree vault-icon-button" aria-label="Открыть дерево заметок" variant="ghost" onPress={() => setTreeOpen(true)}><LayoutSideContentLeft aria-hidden="true" /></Button>
    } mainMenu={<VaultMenu label="Меню LiveNote" triggerIcon={Bars} onAction={(action) => {
        if (action === 'open-folder') void openFolder();
        if (action === 'import') fileRef.current?.click();
        if (action === 'export' && activeDocument) void exportPage(activeDocument.path);
        if (action === 'export-all') void exportAll();
        if (action === 'theme') changeTheme();
        if (action === 'settings') setSettingsOpen(true);
        if (action === 'diagnostics') setDiagnosticsOpen(true);
      }} actions={[
        ...(config.folderPickerAvailable === true ? [{ id: 'open-folder', label: 'Открыть папку', icon: FolderOpen }] : []),
        { id: 'import', label: 'Импорт Markdown', icon: ArrowDownToSquare },
        { id: 'export', label: 'Экспорт документа', icon: ArrowUpFromSquare },
        { id: 'export-all', label: 'Экспорт хранилища', icon: ArrowUpFromSquare },
        { id: 'theme', label: theme === 'dark' ? 'Светлая тема' : 'Тёмная тема', icon: theme === 'dark' ? Sun : Moon },
        ...(workspace.snapshot.problems.length > 0 ? [{ id: 'diagnostics', label: 'Диагностика хранилища' }] : []),
        { id: 'settings', label: 'Настройки', icon: Gear }
      ]} />} />
    <input ref={fileRef} className="vault-visually-hidden" type="file" aria-hidden="true" tabIndex={-1} accept=".md,.markdown,text/markdown" onChange={(event) => {
      const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '';
    }} />
    <VaultWorkspaceLayout sidebar={<VaultSidebar workspace={workspace} {...folderExpansion} onFileAction={(action, path) => void fileAction(action, path)} onFolderAction={(action, path) => void folderAction(action, path)} />}>
      <VaultEditors workspace={workspace} theme={theme} vimEnabled={vimEnabled} onRevealFolder={revealFolder} />
    </VaultWorkspaceLayout>
    <Drawer.Backdrop isOpen={treeOpen} onOpenChange={setTreeOpen}><Drawer.Content placement="left" className="vault-mobile-drawer"><Drawer.Dialog aria-label="Дерево заметок">
      <Drawer.Header><Drawer.Heading>Файлы</Drawer.Heading><Drawer.CloseTrigger aria-label="Закрыть дерево" /></Drawer.Header><Drawer.Body><VaultSidebar workspace={workspace} {...folderExpansion} onNavigate={() => setTreeOpen(false)} onFileAction={(action, path) => void fileAction(action, path)} onFolderAction={(action, path) => void folderAction(action, path)} /></Drawer.Body>
    </Drawer.Dialog></Drawer.Content></Drawer.Backdrop>
    <DiagnosticsDialog open={diagnosticsOpen} problems={workspace.snapshot.problems} onOpenChange={setDiagnosticsOpen} />
    {operation && <VaultPathDialog open title="Переместить" label="Путь" initialPath={operation.path} confirmLabel="Сохранить" onOpenChange={(open) => { if (!open) setOperation(null); }} onSubmit={submitOperation} />}
    {settingsOpen && <SettingsDialog pageWidth={pageWidth} onPageWidthChange={(width) => { setPageWidth(width); localStorage.setItem('livenote_page_width', width); }} followEvents={follow} onFollowChange={(value) => { setFollow(value); localStorage.setItem('livenote_follow', value ? '1' : '0'); }} vimEnabled={vimEnabled} onVimEnabledChange={(value) => { setVimEnabled(value); localStorage.setItem('livenote_vim', value ? '1' : '0'); }} onClose={() => setSettingsOpen(false)} />}
    {workspace.tokenOpen && <TokenDialog onConfirm={workspace.confirmToken} />}
    {folderNotice && <Alert className="vault-global-error" color={folderNotice.kind === 'error' ? 'danger' : 'default'} role={folderNotice.kind === 'error' ? 'alert' : 'status'}><Alert.Content><Alert.Title>{folderNotice.kind === 'error' ? 'Не удалось открыть папку' : folderNotice.kind === 'pending' ? 'Ожидание выбора папки' : 'Выбор папки отменён'}</Alert.Title><Alert.Description>{folderNotice.text}</Alert.Description></Alert.Content>{folderNotice.kind !== 'pending' && <Button size="sm" variant="ghost" onPress={() => setFolderNotice(null)}>Закрыть</Button>}</Alert>}
    {workspace.error && <Alert className="vault-global-error" color="danger" role="alert"><Alert.Content><Alert.Title>Не удалось выполнить действие</Alert.Title><Alert.Description>{workspace.error}</Alert.Description></Alert.Content><Button size="sm" variant="ghost" onPress={workspace.clearError}>Закрыть</Button></Alert>}
    {dialog}
  </div>;
}
