import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, Disclosure, Dropdown, Input, Label, SearchField, Surface } from '@heroui/react';
import { ArrowRightToSquare, File, FilePlus, Folder, FolderPlus, Pencil, Plus, TrashBin } from '@gravity-ui/icons';
import type { VaultSearchHit } from '../../shared/types';
import type { VaultWorkspace } from './useVaultWorkspace';
import type { VaultFileEntry } from './vaultPaths';
import { fileName, fileStem, formatForPath, joinPath, parentPath } from './vaultPaths';

interface FolderNode {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, FolderNode>;
  readonly files: VaultFileEntry[];
}

function makeTree(files: readonly VaultFileEntry[], folders: readonly string[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: new Map(), files: [] };
  const ensure = (path: string): FolderNode => {
    let node = root;
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current = joinPath(current, part);
      const next = node.folders.get(part) ?? { name: part, path: current, folders: new Map(), files: [] };
      node.folders.set(part, next);
      node = next;
    }
    return node;
  };
  for (const folder of folders) ensure(folder);
  for (const file of files) {
    if (file.kind === 'markdown') ensure(parentPath(file.path)).files.push(file);
  }
  return root;
}

type TreeItem = { readonly kind: 'folder' | 'file'; readonly path: string };
type Editing = TreeItem & { readonly name: string; readonly error: string | null };
type MenuPosition = TreeItem & { readonly x: number; readonly y: number };

interface SidebarProps {
  readonly workspace: VaultWorkspace;
  readonly expandedFolders: ReadonlySet<string>;
  readonly setFoldersExpanded: (paths: readonly string[], expanded: boolean) => void;
  readonly onNavigate?: () => void;
  readonly onDiagnostics: () => void;
  readonly onFileAction: (action: string, path: string) => void;
  readonly onFolderAction: (action: string, path: string) => void;
}

export function VaultSidebar({ workspace, expandedFolders, setFoldersExpanded, onNavigate, onDiagnostics, onFileAction, onFolderAction }: SidebarProps): React.JSX.Element {
  const { snapshot, activeId, hits, selectedFolder } = workspace;
  const vaultName = snapshot.vaultName ?? 'Проект';
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<MenuPosition | null>(null);
  const [dragged, setDragged] = useState<TreeItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const editingRef = useRef(editing);
  const renaming = useRef(false);
  editingRef.current = editing;
  const tree = useMemo(() => makeTree(snapshot.files, snapshot.folders), [snapshot.files, snapshot.folders]);
  useEffect(() => {
    const tag = /^#(\S+)$/.exec(query.trim())?.[1];
    const text = tag === undefined ? query : '';
    const timer = window.setTimeout(() => void workspace.search(text, tag), 180);
    return () => window.clearTimeout(timer);
  }, [query, workspace.search]);
  const open = (id: string): void => { workspace.setSelectedFolder(parentPath(id)); workspace.openPage(id); onNavigate?.(); };
  const revealFolder = (folder: string): void => {
    const ancestors: string[] = [];
    for (let path = folder; path; path = parentPath(path)) ancestors.push(path);
    setFoldersExpanded(ancestors, true);
  };

  const create = async (kind: TreeItem['kind'], folder: string): Promise<void> => {
    const base = kind === 'folder' ? 'Новая папка' : 'Новая заметка';
    const occupied = new Set([...snapshot.folders, ...snapshot.files.map((file) => file.path)].map((path) => path.toLocaleLowerCase()));
    let index = 1;
    let name = base;
    let path = joinPath(folder, `${name}${kind === 'file' ? '.md' : ''}`);
    while (occupied.has(path.toLocaleLowerCase())) {
      name = `${base} ${++index}`;
      path = joinPath(folder, `${name}${kind === 'file' ? '.md' : ''}`);
    }
    const error = kind === 'folder' ? await workspace.createFolder(path) : await workspace.createDocument(name, path);
    if (error) { workspace.showError(error); return; }
    workspace.setSelectedFolder(folder);
    revealFolder(folder);
    setEditing({ kind, path, name, error: null });
  };

  const rename = async (): Promise<void> => {
    const item = editingRef.current;
    if (!item || renaming.current) return;
    const name = item.name.trim();
    if (!name || name.includes('/') || name === '.' || name === '..') {
      setEditing({ ...item, error: 'Введите имя без символа /.' });
      return;
    }
    const extension = item.kind === 'file' ? fileName(item.path).slice(fileStem(item.path).length) : '';
    const target = joinPath(parentPath(item.path), `${name}${extension}`);
    if (target === item.path) { setEditing(null); return; }
    renaming.current = true;
    try {
      const error = item.kind === 'file' ? await workspace.move(item.path, target) : await workspace.moveFolder(item.path, target);
      if (error) setEditing((current) => current?.path === item.path ? { ...current, error } : current);
      else setEditing(null);
    } finally { renaming.current = false; }
  };

  const action = (actionId: string, item: TreeItem): void => {
    if (actionId === 'select') {
      workspace.setSelectedFolder(item.path);
    } else if (actionId === 'create-file' || actionId === 'create-folder') {
      const folder = item.kind === 'folder' ? item.path : parentPath(item.path);
      void create(actionId === 'create-file' ? 'file' : 'folder', folder);
    } else if (actionId === 'rename') {
      setEditing({ ...item, name: item.kind === 'file' ? fileStem(item.path) : fileName(item.path), error: null });
    } else if (item.kind === 'file') onFileAction(actionId, item.path);
    else onFolderAction(actionId, item.path);
  };

  const canDrop = (folder: string): boolean => dragged !== null && parentPath(dragged.path) !== folder
    && (dragged.kind !== 'folder' || (folder !== dragged.path && !folder.startsWith(`${dragged.path}/`)));
  const dropProps = (folder: string) => ({
    'data-drop-target': dropTarget === folder && canDrop(folder) ? 'true' : undefined,
    'data-drop-invalid': dropTarget === folder && !canDrop(folder) ? 'true' : undefined,
    onDragOver: (event: React.DragEvent) => { if (!dragged) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = canDrop(folder) ? 'move' : 'none'; setDropTarget(folder); },
    onDragLeave: (event: React.DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault(); event.stopPropagation(); setDropTarget(null);
      if (!dragged || !canDrop(folder)) return;
      const target = joinPath(folder, fileName(dragged.path));
      const operation = dragged.kind === 'file' ? workspace.move(dragged.path, target) : workspace.moveFolder(dragged.path, target);
      void operation.then((error) => {
        if (error) workspace.showError(error);
        else revealFolder(folder);
      });
      setDragged(null);
    }
  });

  const treeProps: TreeProps = {
    activeId, selectedFolder, expandedFolders, setFoldersExpanded, editing, setEditing, rename,
    cancelRename: () => { editingRef.current = null; setEditing(null); }, open, action,
    context: (item, x, y) => setMenu({ ...item, x, y }),
    drag: (event, item) => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.path); setDragged(item); },
    endDrag: () => { setDragged(null); setDropTarget(null); }, dropProps
  };

  return <div className="vault-sidebar__content">
    <div className="vault-sidebar__heading">
      <div className="vault-root-drop" {...dropProps('')}>
        <Button className="vault-root-select" data-selected={selectedFolder === '' ? 'true' : undefined}
          variant="ghost" onPress={() => workspace.setSelectedFolder('')}><span title={vaultName}>{vaultName}</span></Button>
      </div>
      <div className="vault-sidebar__heading-actions"><Dropdown>
        <Dropdown.Trigger aria-label="Создать" className="vault-icon-button"><Plus aria-hidden="true" /></Dropdown.Trigger>
        <Dropdown.Popover placement="bottom end"><Dropdown.Menu aria-label="Создать" onAction={(key) => void create(key === 'folder' ? 'folder' : 'file', selectedFolder)}>
          <Dropdown.Item id="folder" textValue="Папка"><FolderPlus aria-hidden="true" /><Label>Папка</Label></Dropdown.Item>
          <Dropdown.Item id="file" textValue="Файл"><FilePlus aria-hidden="true" /><Label>Файл</Label></Dropdown.Item>
        </Dropdown.Menu></Dropdown.Popover>
      </Dropdown></div>
    </div>
    <SearchField aria-label="Поиск по заметкам" value={query} onChange={setQuery}>
      <Label className="sr-only">Поиск по заметкам</Label><SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="Поиск" /><SearchField.ClearButton aria-label="Очистить поиск" /></SearchField.Group>
    </SearchField>
    <div className="vault-sidebar__scroll">
      {hits !== null ? <SearchResults hits={hits.filter((hit) => formatForPath(hit.path) === 'markdown')} onOpen={open} /> : snapshot.files.length === 0 && snapshot.folders.length <= 1
        ? <p className="vault-empty">Создайте первую заметку в хранилище.</p>
        : <nav aria-label="Файлы хранилища"><FolderView folder={tree} {...treeProps} root /></nav>}
    </div>
    <Dropdown isOpen={menu !== null} onOpenChange={(open) => { if (!open) setMenu(null); }}>
      <Dropdown.Trigger aria-label="Контекстное меню файла" className="vault-context-anchor" style={menu ? { left: menu.x, top: menu.y } : undefined} />
      <Dropdown.Popover><Dropdown.Menu aria-label="Действия элемента" onAction={(key) => { if (menu) action(key.toString(), menu); setMenu(null); }}>
        <Dropdown.SubmenuTrigger><Dropdown.Item textValue="Создать"><Plus aria-hidden="true" /><Label>Создать</Label><Dropdown.SubmenuIndicator /></Dropdown.Item>
          <Dropdown.Popover><Dropdown.Menu aria-label="Создать элемент" onAction={(key) => { if (menu) action(key.toString(), menu); setMenu(null); }}>
            <Dropdown.Item id="create-folder" textValue="Папка"><FolderPlus aria-hidden="true" /><Label>Папка</Label></Dropdown.Item>
            <Dropdown.Item id="create-file" textValue="Файл"><FilePlus aria-hidden="true" /><Label>Файл</Label></Dropdown.Item>
          </Dropdown.Menu></Dropdown.Popover>
        </Dropdown.SubmenuTrigger>
        <Dropdown.Item id="rename" textValue="Переименовать"><Pencil aria-hidden="true" /><Label>Переименовать</Label></Dropdown.Item>
        <Dropdown.Item id="move" textValue="Переместить"><ArrowRightToSquare aria-hidden="true" /><Label>Переместить</Label></Dropdown.Item>
        <Dropdown.Item id="delete" textValue="Удалить" variant="danger"><TrashBin aria-hidden="true" /><Label>Удалить</Label></Dropdown.Item>
      </Dropdown.Menu></Dropdown.Popover>
    </Dropdown>
    {snapshot.problems.length > 0 && <Surface className="vault-problem-summary" variant="secondary"><Chip color="warning" size="sm" variant="soft">{snapshot.problems.length}</Chip><span>Файлы требуют внимания</span><Button size="sm" variant="tertiary" onPress={onDiagnostics}>Подробнее</Button></Surface>}
  </div>;
}

function SearchResults({ hits, onOpen }: { readonly hits: VaultSearchHit[] | null; readonly onOpen: (id: string) => void }): React.JSX.Element {
  if (!hits || hits.length === 0) return <p className="vault-empty">Совпадений нет.</p>;
  return <div className="vault-search-results" aria-label="Результаты поиска">{hits.map((hit) => <Button key={hit.pageId} variant="ghost" className="vault-search-hit" onPress={() => onOpen(hit.pageId)}>
    <span className="vault-search-hit__title">{hit.title}</span><span className="vault-search-hit__path">{hit.path}</span>{hit.excerpt && <span className="vault-search-hit__excerpt">{hit.excerpt}</span>}
  </Button>)}</div>;
}

interface TreeProps {
  readonly activeId: string | null;
  readonly selectedFolder: string;
  readonly expandedFolders: SidebarProps['expandedFolders'];
  readonly setFoldersExpanded: SidebarProps['setFoldersExpanded'];
  readonly editing: Editing | null;
  readonly setEditing: React.Dispatch<React.SetStateAction<Editing | null>>;
  readonly rename: () => Promise<void>;
  readonly cancelRename: () => void;
  readonly open: (path: string) => void;
  readonly action: (action: string, item: TreeItem) => void;
  readonly context: (item: TreeItem, x: number, y: number) => void;
  readonly drag: (event: React.DragEvent, item: TreeItem) => void;
  readonly endDrag: () => void;
  readonly dropProps: (folder: string) => React.HTMLAttributes<HTMLElement>;
}

function FolderView({ folder, root = false, ...props }: TreeProps & { readonly folder: FolderNode; readonly root?: boolean }): React.JSX.Element {
  const expanded = props.expandedFolders.has(folder.path);
  const folders = Array.from(folder.folders.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const files = [...folder.files].sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  const name = (item: TreeItem, label: string): React.ReactNode => props.editing?.path === item.path ? <span>
    <Input autoFocus aria-label="Имя элемента" className="vault-tree__rename" value={props.editing.name}
      onChange={(event) => props.setEditing((current) => current ? { ...current, name: event.target.value, error: null } : current)}
      onBlur={() => void props.rename()}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); void props.rename(); } if (event.key === 'Escape') { event.preventDefault(); props.cancelRename(); } }} />
    {props.editing.error && <span role="alert">{props.editing.error}</span>}
  </span> : label;
  const content = <ul className={root ? 'vault-tree vault-tree--root' : 'vault-tree'}>
    {folders.map((child) => <FolderView key={child.path} folder={child} {...props} />)}
    {files.map((file) => {
      const item: TreeItem = { kind: 'file', path: file.path };
      return <li className="vault-tree__file" key={file.path} draggable={props.editing?.path !== file.path}
        onDragStart={(event) => props.drag(event, item)} onDragEnd={props.endDrag} onContextMenu={(event) => {
          event.preventDefault(); event.stopPropagation(); props.context(item, event.clientX, event.clientY);
        }}>
        {props.editing?.path === file.path ? name(item, file.title) : <Button variant="ghost" className="vault-tree__page" data-active={props.activeId === file.path ? 'true' : undefined} onPress={() => props.open(file.path)}>
          <File aria-hidden="true" /><span>{file.title}</span>
        </Button>}
      </li>;
    })}
  </ul>;
  if (root) return content;
  const item: TreeItem = { kind: 'folder', path: folder.path };
  return <li className="vault-tree__folder"><Disclosure isExpanded={expanded} onExpandedChange={value => props.setFoldersExpanded([folder.path], value)}>
    <div className="vault-tree__folder-row" data-selected={props.selectedFolder === folder.path ? 'true' : undefined}
      draggable={props.editing?.path !== folder.path} onDragStart={(event) => props.drag(event, item)} onDragEnd={props.endDrag}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); props.context(item, event.clientX, event.clientY); }} {...props.dropProps(folder.path)}>
      <Disclosure.Heading>{props.editing?.path === folder.path ? name(item, folder.name) : <Disclosure.Trigger className="vault-tree__folder-trigger" onPress={() => props.action('select', item)}>
        <Disclosure.Indicator /><Folder aria-hidden="true" /><span>{folder.name}</span>
      </Disclosure.Trigger>}</Disclosure.Heading>
    </div><Disclosure.Content>{content}</Disclosure.Content>
  </Disclosure></li>;
}
