import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Disclosure, Dropdown, Input, Label, Spinner, TextField } from '@heroui/react';
import { ArrowDownToSquare, ArrowsExpand, Copy, FilePlus, Link, Pencil, Plus, Scissors, TrashBin } from '@gravity-ui/icons';
import type { DiagramFormat, VaultDocument } from '../../shared/types';
import { downloadTextFile } from '../svgDownload';
import { LivePreviewEditor } from '../editor/LivePreviewEditor';
import type { EditorContext, EditorVimMode, LivePreviewEditorHandle, SourceRange } from '../editor/LivePreviewEditor';
import { DiagramPreview } from '../diagrams';
import { useVaultDiagrams } from './useVaultDiagrams';
import { fileName, formatForPath, joinPath, parentPath, resolveDocumentLink } from './vaultPaths';
import type { VaultWorkspace } from './useVaultWorkspace';

interface DocumentViewProps {
  readonly workspace: VaultWorkspace;
  readonly document: VaultDocument;
  readonly active: boolean;
  readonly theme: 'light' | 'dark';
  readonly vimEnabled: boolean;
  readonly onVimModeChange: (mode: EditorVimMode) => void;
}

export function VaultDocumentView({ workspace, document, active, theme, vimEnabled, onVimModeChange }: DocumentViewProps): React.JSX.Element {
  const editorRef = useRef<LivePreviewEditorHandle>(null);
  const contextSource = useRef('');
  const [context, setContext] = useState<EditorContext | null>(null);
  const [title, setTitle] = useState(document.page.title);
  const [localError, setLocalError] = useState<string | null>(null);
  const pageId = document.path;
  const draft = workspace.drafts[pageId];
  const source = draft?.source ?? document.source;
  const dirty = draft?.source !== document.source;
  const diagrams = useVaultDiagrams(workspace, document, editorRef);
  const format = formatForPath(pageId);

  useEffect(() => { setTitle(document.page.title); setContext(null); }, [document.page.title, pageId]);
  useEffect(() => {
    const target = workspace.fragmentTarget;
    if (!active || !target || target.pageId !== pageId) return;
    let fragment: string;
    try { fragment = decodeURIComponent(target.fragment); } catch { workspace.clearFragmentTarget(); return; }
    const slug = (value: string): string => value.trim().toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s+/g, '-');
    const article = window.document.querySelector<HTMLElement>(`.vault-document[data-page-id="${CSS.escape(pageId)}"]`);
    const element = Array.from(article?.querySelectorAll<HTMLElement>('.lp-heading') ?? [])
      .find((heading) => slug(heading.textContent ?? '') === slug(fragment));
    element?.scrollIntoView({ block: 'start' }); workspace.clearFragmentTarget();
  }, [active, pageId, source, workspace.fragmentTarget]);

  const rename = async (): Promise<void> => {
    const next = title.trim();
    if (!next || next === document.page.title) { setTitle(document.page.title); return; }
    const extension = fileName(pageId).slice(fileStemLength(pageId));
    const error = await workspace.move(pageId, joinPath(parentPath(pageId), `${next}${extension}`));
    if (error) { setLocalError(error); setTitle(document.page.title); }
  };

  const clipboard = async (action: string): Promise<void> => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = editor.getSelection();
    const selected = source.slice(range.from, range.to);
    try {
      if (action === 'copy') await navigator.clipboard.writeText(selected);
      if (action === 'cut') { await navigator.clipboard.writeText(selected); editor.replaceRange(range, ''); }
      if (action === 'paste') editor.replaceRange(range, await navigator.clipboard.readText());
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
  };

  const menuAction = (action: string): void => {
    const range: SourceRange = context ? { from: context.from, to: context.to } : editorRef.current?.getSelection() ?? { from: source.length, to: source.length };
    setContext(null);
    if (action === 'mermaid' || action === 'bpmn' || action === 'drawio') diagrams.openCreate(action, { from: range.from, to: range.from });
    else if (action === 'existing') diagrams.chooseExisting({ from: range.from, to: range.from });
    else if (action === 'edit' && context?.diagram) diagrams.openEdit(context.diagram);
    else if (action === 'view' && context?.diagram) diagrams.openView(context.diagram);
    else if (action === 'remove' && context?.diagram) diagrams.remove(context.diagram, contextSource.current);
    else void clipboard(action);
  };

  const openLink = (target: string): void => {
    const link = resolveDocumentLink(document, target);
    if (link?.targetPageId) workspace.openLinkedPage(link.targetPageId, link.fragment ?? undefined);
    else if (/^https?:\/\//i.test(target)) window.open(target, '_blank', 'noopener,noreferrer');
  };

  return <article className="vault-document" data-page-id={pageId} hidden={!active}>
    <header className="vault-document__header">
      <TextField className="vault-title-field" fullWidth value={title} onChange={setTitle} onBlur={() => void rename()}>
        <Label className="sr-only">Имя файла</Label><Input aria-label="Имя файла" onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
      </TextField>
      <div className="vault-document__actions">
        <Dropdown><Dropdown.Trigger aria-label="Вставить диаграмму" className="vault-icon-button"><Plus aria-hidden="true" /></Dropdown.Trigger>
          <Dropdown.Popover placement="bottom end"><Dropdown.Menu aria-label="Вставить диаграмму" onAction={(key) => menuAction(key.toString())}>
            <InsertItems onAction={menuAction} />
          </Dropdown.Menu></Dropdown.Popover>
        </Dropdown>
      </div>
    </header>
    <div className="vault-document__meta">
      <span className="vault-document__state" aria-live="polite">{draft?.saving ? 'Сохранение…' : draft?.conflict ? 'Конфликт' : dirty ? 'Черновик' : 'Сохранено'}</span>
      {draft?.externalChange && <span>Внешнее изменение обнаружено</span>}
      <span className="vault-document__format">{format === 'markdown' ? 'Markdown' : format}</span>
    </div>
    {(draft?.conflict || localError) && <Alert color="warning" role="alert"><Alert.Content><Alert.Title>Изменения требуют внимания</Alert.Title><Alert.Description>{draft?.conflict ?? localError}</Alert.Description></Alert.Content>
      <div className="vault-alert__actions"><Button size="sm" variant="outline" onPress={() => downloadTextFile(source, fileName(pageId), 'text/markdown')}>Скачать черновик</Button>
        <Button size="sm" variant="danger" onPress={() => workspace.discardDraft(pageId)}>Перечитать и отменить</Button></div>
    </Alert>}
    {format === 'markdown' ? <LivePreviewEditor ref={editorRef} source={source} onChange={(next) => workspace.changeDraft(pageId, next)}
      renderDiagram={diagrams.renderDiagram} vimEnabled={vimEnabled} theme={theme} ariaLabel={`Документ ${document.page.title}`}
      onVimModeChange={onVimModeChange} onSave={() => void workspace.saveDraft(pageId)} onOpenLink={openLink}
      onContextMenu={(next) => { contextSource.current = source; setContext(next); }} readOnly={draft?.modalOpen ?? false} /> : <div className="vault-standalone-diagram">
      <DiagramPreview value={{ format: format as DiagramFormat, source: document.source, title: document.page.title }}
        onExpand={() => diagrams.openView({ from: 0, to: source.length, format: format as DiagramFormat, source })}
        onEdit={() => diagrams.openEdit({ from: 0, to: source.length, format: format as DiagramFormat, source })} />
    </div>}
    {format === 'markdown' && <Disclosure className="vault-backlinks"><Disclosure.Heading><Disclosure.Trigger>Связанные заметки <span>{document.backlinks.length}</span><Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
      <Disclosure.Content>{document.backlinks.length === 0 ? <p>На этот документ пока никто не ссылается.</p> : <div className="vault-backlinks__list">{document.backlinks.map((backlink) => <Button key={backlink.pageId} variant="ghost" onPress={() => workspace.openPage(backlink.pageId)}><Link aria-hidden="true" /><span>{backlink.title}</span><small>{backlink.path}</small></Button>)}</div>}</Disclosure.Content>
    </Disclosure>}
    <Dropdown isOpen={context !== null} onOpenChange={(open) => { if (!open) setContext(null); }}>
      <Dropdown.Trigger aria-label="Контекстное меню документа" className="vault-context-anchor" style={context ? { left: context.clientX, top: context.clientY } : undefined} />
      <Dropdown.Popover><Dropdown.Menu aria-label="Действия документа" onAction={(key) => menuAction(key.toString())}>
        {context?.diagram ? <><Dropdown.Item id="edit" textValue="Редактировать диаграмму"><Pencil aria-hidden="true" /><Label>Редактировать диаграмму</Label></Dropdown.Item>
          <Dropdown.Item id="view" textValue="Открыть диаграмму"><ArrowsExpand aria-hidden="true" /><Label>Открыть диаграмму</Label></Dropdown.Item>
          <Dropdown.Item id="remove" textValue="Удалить диаграмму" variant="danger"><TrashBin aria-hidden="true" /><Label>Удалить диаграмму</Label></Dropdown.Item></> : <InsertItems onAction={menuAction} />}
        <Dropdown.Item id="copy" textValue="Копировать"><Copy aria-hidden="true" /><Label>Копировать</Label></Dropdown.Item>
        <Dropdown.Item id="cut" textValue="Вырезать"><Scissors aria-hidden="true" /><Label>Вырезать</Label></Dropdown.Item>
        <Dropdown.Item id="paste" textValue="Вставить"><ArrowDownToSquare aria-hidden="true" /><Label>Вставить</Label></Dropdown.Item>
      </Dropdown.Menu></Dropdown.Popover>
    </Dropdown>
    {diagrams.dialogs}
  </article>;
}

function InsertItems({ onAction }: { readonly onAction: (action: string) => void }): React.JSX.Element {
  return <Dropdown.SubmenuTrigger><Dropdown.Item textValue="Вставить диаграмму"><FilePlus aria-hidden="true" /><Label>Вставить диаграмму</Label><Dropdown.SubmenuIndicator /></Dropdown.Item>
    <Dropdown.Popover><Dropdown.Menu aria-label="Формат диаграммы" onAction={(key) => onAction(key.toString())}>
      <Dropdown.Item id="mermaid" textValue="Mermaid">Mermaid</Dropdown.Item><Dropdown.Item id="bpmn" textValue="BPMN">BPMN</Dropdown.Item><Dropdown.Item id="drawio" textValue="draw.io">draw.io</Dropdown.Item>
      <Dropdown.Item id="existing" textValue="Существующий файл">Существующий файл</Dropdown.Item>
    </Dropdown.Menu></Dropdown.Popover>
  </Dropdown.SubmenuTrigger>;
}

function fileStemLength(path: string): number {
  const name = fileName(path); return name.length - (name.match(/\.[^.]+$/)?.[0].length ?? 0);
}

export function VaultDocumentLoading(): React.JSX.Element {
  return <div className="vault-loading" role="status"><Spinner aria-label="Загрузка документа" /> Загрузка документа…</div>;
}
