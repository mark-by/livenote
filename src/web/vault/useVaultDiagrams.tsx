import { useCallback, useRef, useState } from 'react';
import { Alert, Button } from '@heroui/react';
import type { DiagramFormat, SourceRange, VaultDocument, WriteLayout } from '../../shared/types';
import { getVaultDocument } from '../api';
import { DiagramDialog, DiagramPreview } from '../diagrams';
import type { DiagramSession, DiagramValue } from '../diagrams';
import type { EditorDiagram, LivePreviewEditorHandle } from '../editor/LivePreviewEditor';
import { parseEditorDiagrams } from '../editor/parseDiagrams';
import { AssetPickerDialog } from './VaultDialogs';
import type { VaultWorkspace } from './useVaultWorkspace';
import { insertBlockAt, mermaidFence, nextAssetPath, relativeVaultPath, resolveDiagramAsset } from './vaultPaths';

interface SessionContext {
  readonly session: DiagramSession;
  readonly range: SourceRange;
  readonly draftEpoch: number;
  readonly draftSource: string;
  readonly originalRangeSource: string;
  readonly asset?: { path: string; version: string | null };
  readonly replacement?: string;
  readonly insertion?: { from: number; to: number; text: string };
}

interface DiagramControls {
  readonly renderDiagram: (diagram: EditorDiagram) => React.ReactNode;
  readonly openCreate: (format: DiagramFormat, range: SourceRange) => void;
  readonly openEdit: (diagram: EditorDiagram) => void;
  readonly openView: (diagram: EditorDiagram) => void;
  readonly remove: (diagram: EditorDiagram, expectedSource: string) => void;
  readonly chooseExisting: (range: SourceRange) => void;
  readonly dialogs: React.ReactNode;
}

export function useVaultDiagrams(workspace: VaultWorkspace, document: VaultDocument, editorRef: React.RefObject<LivePreviewEditorHandle | null>): DiagramControls {
  const [context, setContext] = useState<SessionContext | null>(null);
  const [pickerRange, setPickerRange] = useState<SourceRange | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  const pageId = document.path;
  const draft = workspace.drafts[pageId];
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirty = draft?.source !== document.source;
  const setModalOpen = workspace.setModalOpen;

  const assetFor = useCallback((diagram: EditorDiagram) => resolveDiagramAsset(document, diagram), [document]);
  const remove = useCallback((diagram: EditorDiagram, expectedSource: string): void => {
    const current = draftRef.current;
    if (!current || current.modalOpen) return;
    if (current.source !== expectedSource) { setLocalError('Документ изменился. Выберите диаграмму снова.'); return; }
    const match = parseEditorDiagrams(current.source).find((item) => item.from === diagram.from && item.to === diagram.to
      && item.format === diagram.format && item.source === diagram.source && item.target === diagram.target && item.label === diagram.label);
    if (!match) { setLocalError('Документ изменился. Выберите диаграмму снова.'); return; }
    editorRef.current?.replaceRange({ from: match.from, to: match.to }, '');
  }, [editorRef]);

  const renderDiagram = useCallback((diagram: EditorDiagram): React.ReactNode => {
    const asset = assetFor(diagram);
    const source = diagram.target ? asset?.source ?? '' : diagram.source;
    if (diagram.target && !asset) return <Alert color="warning"><Alert.Content><Alert.Title>Файл схемы не найден</Alert.Title><Alert.Description>{diagram.target}</Alert.Description></Alert.Content></Alert>;
    const span = document.spans.find((item) => item.from === diagram.from && item.to === diagram.to);
    const open = (mode: 'edit' | 'view'): void => {
      if (!draft) return;
      setLocalError(null);
      setContext({
        session: { value: { format: diagram.format, source, ...(diagram.label ? { title: diagram.label } : {}) }, mode, key: `${pageId}:${draft.epoch}:${diagram.from}:${diagram.to}` },
        range: { from: diagram.from, to: diagram.to }, draftEpoch: draft.epoch, draftSource: draft.source,
        originalRangeSource: draft.source.slice(diagram.from, diagram.to),
        ...(asset ? { asset: { path: asset.path, version: asset.version } } : {})
      });
      workspace.setModalOpen(pageId, true);
    };
    return <DiagramPreview value={{ format: diagram.format, source, ...(diagram.label ? { title: diagram.label } : {}) }}
      onExpand={() => open('view')} onEdit={() => open('edit')} onRemove={() => { if (draft) remove(diagram, draft.source); }}
      {...!dirty && span ? { persisted: { pageId, blockId: span.blockId, revision: document.page.revision } } : {}} />;
  }, [assetFor, dirty, document.page.revision, document.spans, draft?.epoch, pageId, remove, setModalOpen]);

  const openCreate = useCallback((format: DiagramFormat, range: SourceRange): void => {
    if (!draft) return;
    setLocalError(null);
    setContext({ session: { value: { format, source: '' }, mode: 'create', key: `${pageId}:${draft.epoch}:${range.from}:create` },
      range, draftEpoch: draft.epoch, draftSource: draft.source, originalRangeSource: '' });
    workspace.setModalOpen(pageId, true);
  }, [draft, pageId, workspace]);

  const close = useCallback((): void => {
    setContext(null); setPickerRange(null); setLocalError(null); workspace.setModalOpen(pageId, false); editorRef.current?.focus();
  }, [editorRef, pageId, workspace]);

  const save = async (value: DiagramValue, options?: { layout?: WriteLayout }): Promise<void> => {
    const captured = contextRef.current;
    if (!captured || !draft) return;
    if (draft.epoch !== captured.draftEpoch || draft.source !== captured.draftSource || draft.source.slice(captured.range.from, captured.range.to) !== captured.originalRangeSource) {
      const error = new Error('Документ изменился. Закройте диалог и откройте схему снова.');
      setLocalError(error.message);
      throw error;
    }
    let source = draft.source;
    let assets: NonNullable<Parameters<VaultWorkspace['commitDiagram']>[1]['assets']> = [];
    let replacement = captured.replacement;
    let insertion = captured.insertion;
    if (captured.session.mode === 'create') {
      if (value.format === 'mermaid') {
        replacement = mermaidFence(value.source);
        const inserted = insertBlockAt(source, captured.range.from, replacement);
        source = inserted.source; insertion = inserted.edit;
      } else {
        const assetPath = nextAssetPath(document.path, value.format, workspace.snapshot.files.map((file) => file.path));
        const embed = `![[${relativeVaultPath(document.path, assetPath)}|${value.title ?? 'Схема'}]]`;
        const inserted = insertBlockAt(source, captured.range.from, embed);
        source = inserted.source; insertion = inserted.edit;
        assets = [{ path: assetPath, source: value.source, expectedVersion: null, ...(options?.layout ? { layout: options.layout } : {}) }];
      }
    } else if (captured.asset) {
      if (captured.asset.path) assets = [{ path: captured.asset.path, source: value.source, expectedVersion: captured.asset.version, ...(options?.layout ? { layout: options.layout } : {}) }];
    } else if (value.format === 'mermaid') {
      replacement = mermaidFence(value.source);
      source = `${source.slice(0, captured.range.from)}${replacement}${source.slice(captured.range.to)}`;
    } else {
      source = value.source;
    }
    try {
      await workspace.commitDiagram(pageId, { draftEpoch: captured.draftEpoch, draftSource: captured.draftSource, source,
        ...(assets.length ? { assets } : {}) });
      if (replacement && captured.session.mode !== 'create') editorRef.current?.replaceRange(captured.range, replacement);
      if (insertion) editorRef.current?.replaceRange({ from: insertion.from, to: insertion.to }, insertion.text);
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
      editorRef.current?.replaceRange(inserted.edit, inserted.edit.text);
      close();
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
  };

  const dialogs = <>
    {context && <DiagramDialog session={context.session} onSave={save} onCancel={close} />}
    <AssetPickerDialog open={pickerRange !== null} files={workspace.snapshot.files} onOpenChange={(open) => { if (!open) close(); }} onChoose={(path) => void choose(path)} />
    {localError && <Alert className="vault-diagram-error" color="danger" role="alert"><Alert.Content><Alert.Description>{localError}</Alert.Description></Alert.Content><Button size="sm" variant="ghost" onPress={() => setLocalError(null)}>Закрыть</Button></Alert>}
  </>;

  return {
    renderDiagram, openCreate, openView: (diagram) => {
      if (!draft) return;
      const asset = assetFor(diagram);
      setContext({ session: { value: { format: diagram.format, source: diagram.target ? asset?.source ?? '' : diagram.source }, mode: 'view', key: `${pageId}:${draft.epoch}:${diagram.from}:view` },
        range: diagram, draftEpoch: draft.epoch, draftSource: draft.source, originalRangeSource: draft.source.slice(diagram.from, diagram.to), ...(asset ? { asset } : {}) });
      workspace.setModalOpen(pageId, true);
    },
    openEdit: (diagram) => {
      if (!draft) return;
      const asset = assetFor(diagram);
      setContext({ session: { value: { format: diagram.format, source: diagram.target ? asset?.source ?? '' : diagram.source, ...(diagram.label ? { title: diagram.label } : {}) }, mode: 'edit', key: `${pageId}:${draft.epoch}:${diagram.from}:edit` },
        range: diagram, draftEpoch: draft.epoch, draftSource: draft.source, originalRangeSource: draft.source.slice(diagram.from, diagram.to), ...(asset ? { asset } : {}) });
      workspace.setModalOpen(pageId, true);
    },
    chooseExisting: (range) => { setPickerRange(range); workspace.setModalOpen(pageId, true); }, remove, dialogs
  };
}
