import { useRef, useState } from 'react';
import { Alert, Button, Drawer, Surface } from '@heroui/react';
import { ArrowDownToSquare, ArrowUpFromSquare, Gear, LayoutSideContentLeft, Moon, Sun } from '@gravity-ui/icons';
import type { ApiConfig } from '../../shared/types';
import { exportAll, exportPage, importMarkdown } from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { SettingsDialog } from '../components/SettingsDialog';
import type { PageWidth } from '../components/SettingsDialog';
import { TokenDialog } from '../components/TokenDialog';
import type { EditorVimMode } from '../editor/LivePreviewEditor';
import { VaultMenu } from './VaultControls';
import { DiagnosticsDialog, VaultPathDialog } from './VaultDialogs';
import { VaultDocumentTabs } from './VaultDocumentTabs';
import { VaultDocumentLoading, VaultDocumentView } from './VaultDocumentView';
import { VaultSidebar } from './VaultSidebar';
import { useVaultWorkspace } from './useVaultWorkspace';
import { fileStem } from './vaultPaths';

interface PathOperation {
  readonly kind: 'move' | 'move-folder';
  readonly path: string;
}

export function VaultApp({ config }: { config: ApiConfig }): React.JSX.Element {
  const workspace = useVaultWorkspace(config.tokenRequired);
  const [treeOpen, setTreeOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [operation, setOperation] = useState<PathOperation | null>(null);
  const [pageWidth, setPageWidth] = useState<PageWidth>(() => {
    const saved = localStorage.getItem('livenote_page_width'); return saved === 'wide' || saved === 'full' ? saved : 'standard';
  });
  const [follow, setFollow] = useState(() => localStorage.getItem('livenote_follow') !== '0');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('livenote_color_theme') === 'dark' ? 'dark' : 'light');
  const [vimEnabled, setVimEnabled] = useState(() => localStorage.getItem('livenote_vim') === '1');
  const [, setVimMode] = useState<EditorVimMode>('normal');
  const fileRef = useRef<HTMLInputElement>(null);
  const { confirm, dialog } = useConfirm();
  const activeDocument = workspace.activeId ? workspace.documents[workspace.activeId] : undefined;

  const changeTheme = (): void => {
    const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next);
    document.documentElement.dataset.theme = next; document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem('livenote_color_theme', next);
  };

  const fileAction = async (action: string, path: string): Promise<void> => {
    if (action === 'delete') {
      const document = workspace.documents[path];
      const title = document?.page.title ?? workspace.snapshot.files.find((file) => file.path === path)?.title ?? path;
      if (await confirm({ title: 'Удалить файл?', message: `«${title}» переедет в корзину хранилища. Ссылки на него останутся в других заметках.`, confirmLabel: 'Удалить', danger: true })) await workspace.removeDocument(path);
    } else setOperation({ kind: 'move', path });
  };

  const folderAction = async (action: string, path: string): Promise<void> => {
    workspace.setSelectedFolder(path);
    if (action === 'delete') {
      const recursive = workspace.snapshot.files.some((file) => file.path.startsWith(`${path}/`))
        || workspace.snapshot.folders.some((folder) => folder.startsWith(`${path}/`));
      if (await confirm({ title: 'Удалить папку?', message: recursive ? `«${path}» и все вложенные файлы переедут в корзину.` : `Пустая папка «${path}» будет удалена.`, confirmLabel: 'Удалить', danger: true })) await workspace.removeFolder(path, recursive);
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
    <header className="vault-topbar">
      <div className="vault-brand"><Button className="vault-mobile-tree vault-icon-button" aria-label="Открыть дерево заметок" variant="ghost" onPress={() => setTreeOpen(true)}><LayoutSideContentLeft aria-hidden="true" /></Button><strong>LiveNote</strong></div>
      <VaultMenu label="Меню LiveNote" triggerIcon={Gear} onAction={(action) => {
        if (action === 'import') fileRef.current?.click();
        if (action === 'export' && activeDocument) void exportPage(activeDocument.path);
        if (action === 'export-all') void exportAll();
        if (action === 'theme') changeTheme();
        if (action === 'settings') setSettingsOpen(true);
      }} actions={[
        { id: 'import', label: 'Импорт Markdown', icon: ArrowDownToSquare },
        { id: 'export', label: 'Экспорт документа', icon: ArrowUpFromSquare },
        { id: 'export-all', label: 'Экспорт хранилища', icon: ArrowUpFromSquare },
        { id: 'theme', label: theme === 'dark' ? 'Светлая тема' : 'Тёмная тема', icon: theme === 'dark' ? Sun : Moon },
        { id: 'settings', label: 'Настройки', icon: Gear }
      ]} />
      <input ref={fileRef} className="vault-visually-hidden" type="file" aria-hidden="true" tabIndex={-1} accept=".md,.markdown,text/markdown" onChange={(event) => {
        const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '';
      }} />
    </header>
    <VaultDocumentTabs workspace={workspace} />
    <div className="vault-workspace">
      <Surface className="vault-sidebar" variant="default"><VaultSidebar workspace={workspace} onDiagnostics={() => setDiagnosticsOpen(true)} onFileAction={(action, path) => void fileAction(action, path)} onFolderAction={(action, path) => void folderAction(action, path)} /></Surface>
      <main className="vault-main">
        {workspace.openTabs.map((path) => {
          const document = workspace.documents[path];
          return document ? <VaultDocumentView key={path} workspace={workspace} document={document} active={workspace.activeId === path} theme={theme} vimEnabled={vimEnabled} onVimModeChange={setVimMode} /> : null;
        })}
        {!activeDocument && (workspace.ready ? <div className="vault-welcome"><h1>Начните с заметки</h1><p>Выберите файл слева или создайте Markdown-документ в текущей папке.</p></div> : <VaultDocumentLoading />)}
      </main>
    </div>
    <Drawer.Backdrop isOpen={treeOpen} onOpenChange={setTreeOpen}><Drawer.Content placement="left" className="vault-mobile-drawer"><Drawer.Dialog aria-label="Дерево заметок">
      <Drawer.Header><Drawer.Heading>Файлы</Drawer.Heading><Drawer.CloseTrigger aria-label="Закрыть дерево" /></Drawer.Header><Drawer.Body><VaultSidebar workspace={workspace} onNavigate={() => setTreeOpen(false)} onDiagnostics={() => { setTreeOpen(false); setDiagnosticsOpen(true); }} onFileAction={(action, path) => void fileAction(action, path)} onFolderAction={(action, path) => void folderAction(action, path)} /></Drawer.Body>
    </Drawer.Dialog></Drawer.Content></Drawer.Backdrop>
    <DiagnosticsDialog open={diagnosticsOpen} problems={workspace.snapshot.problems} onOpenChange={setDiagnosticsOpen} />
    {operation && <VaultPathDialog open title="Переместить" label="Путь" initialPath={operation.path} confirmLabel="Сохранить" onOpenChange={(open) => { if (!open) setOperation(null); }} onSubmit={submitOperation} />}
    {settingsOpen && <SettingsDialog pageWidth={pageWidth} onPageWidthChange={(width) => { setPageWidth(width); localStorage.setItem('livenote_page_width', width); }} followEvents={follow} onFollowChange={(value) => { setFollow(value); localStorage.setItem('livenote_follow', value ? '1' : '0'); }} vimEnabled={vimEnabled} onVimEnabledChange={(value) => { setVimEnabled(value); localStorage.setItem('livenote_vim', value ? '1' : '0'); }} onClose={() => setSettingsOpen(false)} />}
    {workspace.tokenOpen && <TokenDialog onConfirm={workspace.confirmToken} />}
    {workspace.error && <Alert className="vault-global-error" color="danger" role="alert"><Alert.Content><Alert.Title>Не удалось выполнить действие</Alert.Title><Alert.Description>{workspace.error}</Alert.Description></Alert.Content><Button size="sm" variant="ghost" onPress={workspace.clearError}>Закрыть</Button></Alert>}
    {dialog}
  </div>;
}
