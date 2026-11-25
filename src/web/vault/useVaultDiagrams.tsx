import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button } from '@heroui/react';
import type { DiagramFormat, SourceRange, VaultDocument, WriteLayout } from '../../shared/types';
import { getVaultDocument } from '../api';
import { DiagramDialog, DiagramPreview } from '../diagrams';
import type { DiagramValue } from '../diagrams';
import type { EditorDiagram, LivePreviewEditorHandle } from '../editor/LivePreviewEditor';
import { parseEditorDiagrams } from '../editor/parseDiagrams';
import { renameDiagramEmbed } from '../editor/diagramTitleSource';
import { AssetPickerDialog } from './VaultDialogs';
import type { VaultWorkspace } from './useVaultWorkspace';
import { insertBlockAt, relativeVaultPath, resolveDiagramAsset } from './vaultPaths';
import type { DiagramAgentEditor } from '../diagrams/types';
import { prepareDiagramWrite } from './vaultAgentContext';
import type { DiagramContext } from './vaultAgentContext';

interface DiagramControls {
  readonly renderDiagram: (diagram: EditorDiagram) => React.ReactNode;
  readonly openCreate: (format: DiagramFormat, range: SourceRange) => void;
  readonly openEdit: (diagram: EditorDiagram) => void;
  readonly openView: (diagram: EditorDiagram) => void;
  readonly remove: (diagram: EditorDiagram, expectedSource: string) => void;
  readonly chooseExisting: (range: SourceRange) => void;
  readonly dialogs: React.ReactNode;
}

function matchingDiagram(source: string, diagram: EditorDiagram): EditorDiagram | undefined {
  return parseEditorDiagrams(source).find(item => item.from === diagram.from && item.to === diagram.to
    && item.format === diagram.format && item.source === diagram.source && item.target === diagram.target && item.label === diagram.label);
}

export function useVaultDiagrams(workspace: VaultWorkspace, document: VaultDocument, editorRef: React.RefObject<LivePreviewEditorHandle | null>, agentPanel?: React.ReactNode): DiagramControls {
  const [context, setContext] = useState<DiagramContext | null>(null);
  const [pickerRange, setPickerRange] = useState<SourceRange | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const restoreFocus = useRef(false);
  const contextRef = useRef(context);
  contextRef.current = context;
  const agentEditorRef = useRef<DiagramAgentEditor>(null);
  const pageId = document.path;
  const draft = workspace.drafts[pageId];
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirty = draft?.source !== document.source;
  const { setModalOpen, isAgentLocked, registerAgentDiagram } = workspace;

  const assetFor = useCallback((diagram: EditorDiagram) => resolveDiagramAsset(document, diagram), [document]);
  const remove = useCallback((diagram: EditorDiagram, expectedSource: string): void => {
    const current = draftRef.current;
    if (!current || current.modalOpen || isAgentLocked(pageId)) return;
    if (current.source !== expectedSource) { setLocalError('Документ изменился. Выберите диаграмму снова.'); return; }
    const match = matchingDiagram(current.source, diagram);
    if (!match) { setLocalError('Документ изменился. Выберите диаграмму снова.'); return; }
    editorRef.current?.replaceRange({ from: match.from, to: match.to }, '');
  }, [editorRef, isAgentLocked, pageId]);
  const rename = useCallback((diagram: EditorDiagram, title: string, focusEditor: boolean): string | undefined => {
    const current = draftRef.current;
    const editor = editorRef.current;
    if (!current || current.modalOpen || isAgentLocked(pageId) || !editor) return 'Редактор схемы занят.';
    const match = matchingDiagram(current.source, diagram);
    if (!match) return 'Документ изменился. Выберите схему снова.';
    const replacement = renameDiagramEmbed(current.source, match, title);
    if ('error' in replacement) return replacement.error;
    editor.replaceRange(match, replacement.text, { focus: focusEditor });
    return undefined;
  }, [editorRef, isAgentLocked, pageId]);

  const renderDiagram = useCallback((diagram: EditorDiagram): React.ReactNode => {
    const asset = assetFor(diagram);
    const source = diagram.target ? asset?.source ?? '' : diagram.source;
    if (diagram.target && !asset) return <Alert color="warning"><Alert.Content><Alert.Title>Файл схемы не найден</Alert.Title><Alert.Description>{diagram.target}</Alert.Description></Alert.Content></Alert>;
    const span = document.spans.find((item) => item.from === diagram.from && item.to === diagram.to);
    const open = (mode: 'edit' | 'view'): void => {
      const current = draftRef.current;
      if (!current || current.modalOpen || isAgentLocked(pageId)) return;
      if (!matchingDiagram(current.source, diagram)) { setLocalError('Документ изменился. Выберите диаграмму снова.'); return; }
      setLocalError(null);
      setContext({
        session: { value: { format: diagram.format, source, ...(diagram.label ? { title: diagram.label } : {}) }, mode, key: `${pageId}:${current.epoch}:${diagram.from}:${diagram.to}` },
        range: { from: diagram.from, to: diagram.to }, draftEpoch: current.epoch, draftSource: current.source,
        ...(asset ? { asset: { path: asset.path, version: asset.version } } : {})
      });
      setModalOpen(pageId, true);
    };
    const onRename = diagram.target ? { onRename: (title: string, focusEditor: boolean) => rename(diagram, title, focusEditor) } : {};
    return <DiagramPreview value={{ format: diagram.format, source, ...(diagram.label ? { title: diagram.label } : {}) }} {...onRename}
      onExpand={() => open('view')} onEdit={() => open('edit')} onRemove={() => {
        const current = draftRef.current;
        if (current) remove(diagram, current.source);
      }}
      {...!dirty && span ? { persisted: { pageId, blockId: span.blockId, revision: document.page.revision } } : {}} />;
  }, [assetFor, dirty, document.page.revision, document.spans, isAgentLocked, pageId, remove, rename, setModalOpen]);

  const openCreate = useCallback((format: DiagramFormat, range: SourceRange): void => {
    if (!draft || isAgentLocked(pageId)) return;
    setLocalError(null);
    setContext({ session: { value: { format, source: '' }, mode: 'create', key: `${pageId}:${draft.epoch}:${range.from}:create` },
      range, draftEpoch: draft.epoch, draftSource: draft.source });
    workspace.setModalOpen(pageId, true);
  }, [draft, isAgentLocked, pageId, workspace]);

  const close = useCallback((): void => {
    restoreFocus.current = true;
    setContext(null); setPickerRange(null); setLocalError(null); setModalOpen(pageId, false);
  }, [pageId, setModalOpen]);

  useEffect(() => {
    if (context || pickerRange || !restoreFocus.current) return;
    // HeroUI удерживает фокус до размонтирования диалога.
    const frame = requestAnimationFrame(() => {
      restoreFocus.current = false;
      editorRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [context, editorRef, pickerRange]);

  useLayoutEffect(() => {
    if (!context) return;
    return registerAgentDiagram({
      ...context, path: pageId,
      capture() {
        const editor = agentEditorRef.current;
        if (!editor) throw new Error('Дождитесь загрузки редактора схемы.');
        return editor.capture();
      },
      reload(saved, nextDraft, target) {
        const { format, title } = context.session.value;
        const asset = target.kind === 'asset' ? saved.assets.find(item => item.path === target.path) : undefined;
        const parsed = target.kind === 'inline'
          ? parseEditorDiagrams(saved.source).find(item => item.format === format && !item.target && item.from === target.from)
          : undefined;
        const source = target.kind === 'file' ? saved.source : asset?.source ?? parsed?.source;
        if (source === undefined) {
          restoreFocus.current = true;
          setContext(null);
          setModalOpen(pageId, false);
          return;
        }
        const range = parsed ? { from: parsed.from, to: parsed.to } : context.range;
        setContext({
          session: { value: { format, source, ...(title ? { title } : {}) }, mode: context.session.mode === 'view' ? 'view' : 'edit',
            key: `${pageId}:agent:${nextDraft.epoch}` },
          range, draftSource: nextDraft.source, draftEpoch: nextDraft.epoch,
          ...(asset ? { asset: { path: asset.path, version: asset.version } } : {})
        });
      }
    });
  }, [context, editorRef, pageId, registerAgentDiagram, setModalOpen]);

  const save = async (value: DiagramValue, options?: { layout?: WriteLayout }): Promise<void> => {
    const captured = contextRef.current;
    if (!captured || !draft) return;
    try {
      const { write, edit } = prepareDiagramWrite(pageId, draft, captured, value, workspace.snapshot.files.map(file => file.path));
      const layout = options?.layout;
      await workspace.commitDiagram(pageId, layout && write.assets
        ? { ...write, assets: write.assets.map(asset => ({ ...asset, layout })) } : write);
      if (edit) editorRef.current?.replaceRange(edit, edit.text, { focus: false });
      close();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const choose = async (assetPath: string): Promise<void> => {
    const range = pickerRange;
    if (!range || !draft) return;
    const file = workspace.snapshot.files.find((item) => item.path === assetPath);
    if (!file || file.kind === 'markdown') return;
    const embed = `![[${relativeVaultPath(document.path, assetPath)}|${file.title}]]`;
    const inserted = insertBlockAt(draft.source, range.from, embed);
    try {
      const version = document.assets.find((asset) => asset.path === assetPath)?.version ?? (await getVaultDocument(assetPath)).version;
      await workspace.commitDiagram(pageId, { draftEpoch: draft.epoch, draftSource: draft.source, source: inserted.source,
        references: [{ path: assetPath, expectedVersion: version }] });
      editorRef.current?.replaceRange(inserted.edit, inserted.edit.text, { focus: false });
      close();
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
  };

  const dialogs = <>
    {context && <DiagramDialog session={context.session} onSave={save} onCancel={close}
      agentPanel={agentPanel} agentEditorRef={agentEditorRef} agentLocked={workspace.agentLockedPaths?.has(pageId) ?? false} />}
    <AssetPickerDialog open={pickerRange !== null} files={workspace.snapshot.files} onOpenChange={(open) => { if (!open) close(); }} onChoose={(path) => void choose(path)} />
    {localError && <Alert className="vault-diagram-error" color="danger" role="alert"><Alert.Content><Alert.Description>{localError}</Alert.Description></Alert.Content><Button size="sm" variant="ghost" onPress={() => setLocalError(null)}>Закрыть</Button></Alert>}
  </>;

  return {
    renderDiagram, openCreate, openView: (diagram) => {
      if (!draft || isAgentLocked(pageId)) return;
      const asset = assetFor(diagram);
      setContext({ session: { value: { format: diagram.format, source: diagram.target ? asset?.source ?? '' : diagram.source }, mode: 'view', key: `${pageId}:${draft.epoch}:${diagram.from}:view` },
        range: diagram, draftEpoch: draft.epoch, draftSource: draft.source, ...(asset ? { asset } : {}) });
      workspace.setModalOpen(pageId, true);
    },
    openEdit: (diagram) => {
      if (!draft || isAgentLocked(pageId)) return;
      const asset = assetFor(diagram);
      setContext({ session: { value: { format: diagram.format, source: diagram.target ? asset?.source ?? '' : diagram.source, ...(diagram.label ? { title: diagram.label } : {}) }, mode: 'edit', key: `${pageId}:${draft.epoch}:${diagram.from}:edit` },
        range: diagram, draftEpoch: draft.epoch, draftSource: draft.source, ...(asset ? { asset } : {}) });
      workspace.setModalOpen(pageId, true);
    },
    chooseExisting: (range) => {
      if (!isAgentLocked(pageId)) { setPickerRange(range); workspace.setModalOpen(pageId, true); }
    }, remove, dialogs
  };
}
