import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEvent, VaultDocument, VaultMoveResult, VaultSearchHit, VaultSnapshot } from '../../shared/types';
import {
  ApiError, clearToken, createPage, createVaultFolder, deletePage, deleteVaultFolder, getToken,
  getVaultDocument, getVaultSnapshot, moveVaultFolder, moveVaultPage,
  searchVault, setToken, UNAUTHORIZED_EVENT
} from '../api';
import { connectVaultEvents } from './vaultEvents';
import { TEXT_WRITE_CONFLICT, VaultDocumentWrites } from './vaultDocumentWrites';
import type { DiagramWrite, VaultDraft } from './vaultDocumentWrites';
import { remapPath } from './vaultPaths';
import { resizeSplit } from './vaultPaneState';
import type { SplitDirection } from './vaultPaneState';
import { closeVaultPane, focusVaultPane, openVaultTab, remapVaultTabPaths, removeVaultTabs, splitVaultTab } from './vaultTabState';
import type { VaultTabState } from './vaultTabState';

const STORAGE_TABS = 'livenote_open_tabs';
const STORAGE_ACTIVE = 'livenote_active_tab';
const EMPTY_SNAPSHOT: VaultSnapshot = { pages: [], files: [], folders: [''], treeVersion: '', tags: [], problems: [] };

interface HistoryState { readonly entries: readonly string[]; readonly index: number }

// Обработчики и ответы сервера видят последнее изменение до следующего рендера.
function useCurrentState<T>(initialize: () => T) {
  const [state, setState] = useState(initialize);
  const current = useRef(state);
  const update = useCallback((change: (previous: T) => T): void => {
    const next = change(current.current);
    current.current = next;
    setState(next);
  }, []);
  return [state, update, current] as const;
}

function withoutTabs<T>(records: Record<string, T>, ids: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([id]) => !ids.has(id)));
}

function loadTabs(storageKey: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function freshDraft(document: VaultDocument): VaultDraft {
  return { source: document.source, baseRevision: document.page.revision, baseVersion: document.version,
    epoch: 0, saving: false, modalOpen: false, externalChange: false, conflict: null };
}

/** Состояние vault: path-based документы, последовательные сохранения, вкладки и файловые операции. */
export function useVaultWorkspace(tokenRequired: boolean, followEvents: boolean, vaultId: string | null, vaultIdExplicit: boolean) {
  const tabsStorageKey = vaultId === null ? STORAGE_TABS : `${STORAGE_TABS}:${encodeURIComponent(vaultId)}`;
  const activeStorageKey = vaultId === null ? STORAGE_ACTIVE : `${STORAGE_ACTIVE}:${encodeURIComponent(vaultId)}`;
  const [snapshot, updateSnapshot, snapshotRef] = useCurrentState(() => EMPTY_SNAPSHOT);
  const [documents, setDocuments, documentsRef] = useCurrentState<Record<string, VaultDocument>>(() => ({}));
  const [drafts, setDrafts, draftsRef] = useCurrentState<Record<string, VaultDraft>>(() => ({}));
  const [tabs, setTabs, tabsRef] = useCurrentState<VaultTabState>(() => {
    const openTabs = [...new Set(loadTabs(tabsStorageKey))];
    const savedActive = localStorage.getItem(activeStorageKey);
    const activeId = savedActive !== null && openTabs.includes(savedActive) ? savedActive : openTabs[0] ?? null;
    return { openTabs, activeId, previewId: null };
  });
  const { openTabs, activeId, previewId } = tabs;
  const [history, setHistory, historyRef] = useCurrentState<HistoryState>(() => ({ entries: [], index: -1 }));
  const [hits, setHits] = useState<VaultSearchHit[] | null>(null);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(tokenRequired && getToken() === null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [fragmentTarget, setFragmentTarget] = useState<{ pageId: string; fragment: string } | null>(null);
  const [followTarget, setFollowTarget] = useState<{ pageId: string; version: string; position: number } | null>(null);
  const [moveGeneration, setMoveGeneration] = useState(0);

  const loadsRef = useRef(new Map<string, symbol>());
  const snapshotRequestRef = useRef(0);
  const [documentWrites] = useState(() => new VaultDocumentWrites());
  const movingRef = useRef(false);
  const deferredEventsRef = useRef(false);
  const followRef = useRef(followEvents);
  followRef.current = followEvents;

  useEffect(() => {
    const kept = openTabs.filter((id) => id !== previewId);
    localStorage.setItem(tabsStorageKey, JSON.stringify(kept));
    const selected = activeId === previewId ? kept[0] ?? null : activeId;
    if (selected === null) localStorage.removeItem(activeStorageKey);
    else localStorage.setItem(activeStorageKey, selected);
  }, [openTabs, previewId, activeId, tabsStorageKey, activeStorageKey]);

  const isDirty = useCallback((pageId: string): boolean => {
    const draft = draftsRef.current[pageId];
    const document = documentsRef.current[pageId];
    return draft !== undefined && (document === undefined || draft.source !== document.source);
  }, [documentsRef, draftsRef]);

  const protectsTab = useCallback((pageId: string): boolean => {
    const draft = draftsRef.current[pageId];
    return isDirty(pageId) || documentWrites.hasPending(pageId)
      || draft?.saving === true || draft?.modalOpen === true || draft?.conflict != null;
  }, [documentWrites, draftsRef, isDirty]);

  const keepTab = useCallback((pageId: string): void => {
    setTabs((current) => current.previewId === pageId ? { ...current, previewId: null } : current);
  }, [setTabs]);

  const patchDraft = useCallback((pageId: string, patch: Partial<VaultDraft>): void => {
    setDrafts((previous) => previous[pageId] ? { ...previous, [pageId]: { ...previous[pageId], ...patch } } : previous);
  }, [setDrafts]);

  const clearTabData = useCallback((ids: ReadonlySet<string>): void => {
    for (const id of ids) {
      loadsRef.current.delete(id);
      documentWrites.forget(id);
    }
    setDocuments((previous) => withoutTabs(previous, ids));
    setDrafts((previous) => withoutTabs(previous, ids));
    setFragmentTarget((target) => target && ids.has(target.pageId) ? null : target);
    setFollowTarget((target) => target && ids.has(target.pageId) ? null : target);
  }, [documentWrites, setDocuments, setDrafts]);

  const loadDocument = useCallback(async (pageId: string, discard = false, followEvent?: LiveEvent): Promise<void> => {
    if (!tabsRef.current.openTabs.includes(pageId)) return;
    const request = Symbol();
    const draftAtStart = draftsRef.current[pageId];
    loadsRef.current.set(pageId, request);
    try {
      const document = await getVaultDocument(pageId);
      if (loadsRef.current.get(pageId) !== request) return;
      if (documentWrites.deferLoad(pageId)) return;
      const currentDraft = draftsRef.current[pageId];
      const previousDocument = documentsRef.current[pageId];
      if (currentDraft?.modalOpen && currentDraft.externalChange && currentDraft.source === previousDocument?.source) return;
      const protectedDraft = protectsTab(pageId);
      if (followEvent && followRef.current && tabsRef.current.activeId === pageId && !protectedDraft) {
        const previous = previousDocument;
        const span = document.spans.find(item => item.blockId === followEvent.blockId);
        let position = span?.from ?? 0;
        if (!span && previous) {
          if (previous.source !== document.source) {
            while (position < previous.source.length && position < document.source.length
              && previous.source[position] === document.source[position]) position++;
          } else {
            const changed = document.page.blocks.find(block => previous.page.blocks.find(item => item.id === block.id)?.source !== block.source);
            position = document.spans.find(item => item.blockId === changed?.id)?.from ?? 0;
          }
        }
        setFollowTarget({ pageId, version: document.version, position });
      }
      setDocuments((previous) => ({ ...previous, [pageId]: document }));
      setDrafts((previous) => {
        if (!currentDraft || (discard && currentDraft === draftAtStart && !currentDraft.saving && !currentDraft.modalOpen
            && !documentWrites.hasPending(pageId))) return { ...previous, [pageId]: freshDraft(document) };
        if (document.version !== currentDraft.baseVersion) {
          if (!protectedDraft) return { ...previous, [pageId]: freshDraft(document) };
          if (previousDocument?.version !== document.version) return { ...previous, [pageId]: { ...currentDraft, externalChange: true } };
        }
        return previous;
      });
    } catch (loadError) {
      if (loadsRef.current.get(pageId) === request) {
        if (loadError instanceof ApiError && loadError.status === 404 && protectsTab(pageId)) {
          patchDraft(pageId, { conflict: 'Файл удалён или перемещён вне LiveNote. Черновик оставлен без изменений.', externalChange: true });
        } else setError(message(loadError));
      }
    } finally {
      if (loadsRef.current.get(pageId) === request) loadsRef.current.delete(pageId);
    }
  }, [documentWrites, documentsRef, draftsRef, patchDraft, protectsTab, setDocuments, setDrafts, tabsRef]);

  const removeTabs = useCallback((ids: readonly string[], reportBlocked = false): void => {
    const current = tabsRef.current;
    const requested = new Set(ids);
    const closing = new Set<string>();
    const blocked: string[] = [];
    for (const id of current.openTabs) {
      if (!requested.has(id)) continue;
      if (protectsTab(id)) blocked.push(id);
      else closing.add(id);
    }
    if (reportBlocked && blocked.length > 0) {
      setError(`Вкладки остались открыты: ${blocked.join(', ')}. Дождитесь сохранения, закройте диалог или устраните конфликт.`);
    }
    if (closing.size === 0) return;
    const next = removeVaultTabs(current, closing);
    setTabs(() => next);
    clearTabData(closing);
    if (next.activeId !== null && next.activeId !== current.activeId && !documentsRef.current[next.activeId]) {
      void loadDocument(next.activeId);
    }
  }, [clearTabData, documentsRef, loadDocument, protectsTab, setTabs, tabsRef]);

  const closeTabs = useCallback((ids: readonly string[]): void => { removeTabs(ids, true); }, [removeTabs]);
  const closeTab = useCallback((pageId: string): void => { closeTabs([pageId]); }, [closeTabs]);

  const splitTab = (pageId: string, direction: SplitDirection): void => {
    const next = splitVaultTab(tabsRef.current, pageId, direction);
    setTabs(() => next);
    if (next.activeId !== null && !documentsRef.current[next.activeId]) void loadDocument(next.activeId);
  };
  const focusPane = (id: number): void => { setTabs(current => focusVaultPane(current, id)); };
  const resizePaneSplit = (id: number, percent: number): void => {
    setTabs(current => {
      if (!current.layout) return current;
      const layout = resizeSplit(current.layout, id, percent);
      return layout === current.layout ? current : { ...current, layout };
    });
  };
  const closePane = (id: number): void => {
    const next = closeVaultPane(tabsRef.current, id);
    setTabs(() => next);
    if (next.activeId !== null && !documentsRef.current[next.activeId]) void loadDocument(next.activeId);
  };

  const refreshSnapshot = useCallback(async (): Promise<VaultSnapshot | undefined> => {
    const request = ++snapshotRequestRef.current;
    const openAtStart = tabsRef.current.openTabs;
    try {
      const fresh = await getVaultSnapshot();
      if (request !== snapshotRequestRef.current) return;
      updateSnapshot(() => fresh);
      if (openAtStart === tabsRef.current.openTabs) {
        const available = new Set(fresh.files.map((file) => file.path));
        removeTabs(openAtStart.filter((id) => !available.has(id)));
      }
      return fresh;
    } catch (loadError) {
      if (request === snapshotRequestRef.current) throw loadError;
    }
  }, [removeTabs, tabsRef, updateSnapshot]);

  const refresh = useCallback(async (): Promise<void> => {
    try { await refreshSnapshot(); } catch (loadError) { setError(message(loadError)); }
  }, [refreshSnapshot]);

  const activatePage = useCallback(async (pageId: string, fromHistory: boolean, followEvent?: LiveEvent): Promise<void> => {
    const current = tabsRef.current;
    const next = openVaultTab(current, pageId, current.previewId !== null && !protectsTab(current.previewId));
    setTabs(() => next);
    if (current.previewId !== null && !next.openTabs.includes(current.previewId)) {
      clearTabData(new Set([current.previewId]));
    }
    if (!fromHistory && (current.activeId !== pageId || historyRef.current.index < 0)) {
      setHistory((previous) => {
        const entries = [...previous.entries.slice(0, previous.index + 1), pageId];
        return { entries, index: entries.length - 1 };
      });
    }
    if (followEvent || !documentsRef.current[pageId]) await loadDocument(pageId, false, followEvent);
  }, [clearTabData, documentsRef, historyRef, loadDocument, protectsTab, setHistory, setTabs, tabsRef]);

  const openPage = useCallback((pageId: string, fromHistory = false, followEvent?: LiveEvent): void => {
    void activatePage(pageId, fromHistory, followEvent);
  }, [activatePage]);

  const writeDocument = useCallback((pageId: string, draft: VaultDraft, diagram?: DiagramWrite): Promise<VaultDocument> => {
    return documentWrites.put(pageId, { draft, diagram }, {
      draft: () => draftsRef.current[pageId],
      patchDraft: (patch) => patchDraft(pageId, patch),
      publish: (saved) => {
        loadsRef.current.delete(pageId);
        setDocuments((current) => ({ ...current, [pageId]: saved }));
      },
      reload: () => { void loadDocument(pageId); }
    });
  }, [documentWrites, draftsRef, loadDocument, patchDraft, setDocuments]);

  const saveDraft = useCallback((pageId: string): Promise<void> => {
    if (movingRef.current || !tabsRef.current.openTabs.includes(pageId)) return Promise.resolve();
    return documentWrites.enqueue(pageId, async () => {
      const draft = draftsRef.current[pageId];
      if (!draft || draft.conflict || draft.modalOpen) return;
      const document = documentsRef.current[pageId];
      if (document && draft.source === document.source) return;
      setBusy(pageId);
      try {
        await writeDocument(pageId, draft);
        void refresh();
      } catch (saveError) {
        const conflict = saveError instanceof ApiError && saveError.status === 409;
        patchDraft(pageId, { conflict: conflict ? TEXT_WRITE_CONFLICT : message(saveError) });
      } finally {
        setBusy(null);
      }
    });
  }, [documentWrites, documentsRef, draftsRef, patchDraft, refresh, tabsRef, writeDocument]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const [pageId, draft] of Object.entries(drafts)) {
        const document = documents[pageId];
        if (document && draft.source !== document.source && !draft.saving && !draft.modalOpen && !draft.conflict) void saveDraft(pageId);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [drafts, documents, moveGeneration, saveDraft]);

  const bootstrap = useCallback(async (): Promise<void> => {
    try {
      const fresh = await refreshSnapshot();
      if (!fresh) return;
      const initial = tabsRef.current.activeId
        ?? fresh.files.find((file) => file.kind === 'markdown')?.path
        ?? fresh.files[0]?.path;
      if (initial) await activatePage(initial, false);
      setUnavailable(null);
      setReady(true);
    } catch (bootstrapError) {
      const text = vaultIdExplicit
        ? 'Хранилище закрыто или недоступно. Откройте другую папку.'
        : message(bootstrapError);
      setUnavailable(vaultIdExplicit ? text : null);
      setError(vaultIdExplicit ? null : text);
      setReady(true);
    }
  }, [activatePage, refreshSnapshot, tabsRef, vaultIdExplicit]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  useEffect(() => {
    if (!ready) return;
    const onEvent = (event: LiveEvent): void => {
      if (movingRef.current) { deferredEventsRef.current = true; return; }
      void refresh();
      if (event.event === 'page.deleted') {
        if (protectsTab(event.pageId)) patchDraft(event.pageId, { conflict: 'Файл удалён вне LiveNote. Черновик сохранён.', externalChange: true });
        else removeTabs([event.pageId]);
        return;
      }
      if (documentWrites.observe(event)) return;
      if (protectsTab(event.pageId)) {
        patchDraft(event.pageId, { externalChange: true });
      } else {
        const activeId = tabsRef.current.activeId;
        const editing = activeId !== null && protectsTab(activeId);
        const follow = followRef.current && !editing && event.pageId.toLowerCase().endsWith('.md')
          && (event.event === 'page.created' || event.event === 'page.updated' || event.event === 'block.created' || event.event === 'block.updated');
        if (follow) openPage(event.pageId, false, event);
        else if (tabsRef.current.openTabs.includes(event.pageId)) void loadDocument(event.pageId);
      }
    };
    const connection = connectVaultEvents({
      onPageCreated: onEvent, onPageUpdated: onEvent, onPageDeleted: onEvent,
      onPageMoved: onEvent, onVaultUpdated: () => { if (movingRef.current) deferredEventsRef.current = true; else void refresh(); },
      onBlockCreated: onEvent, onBlockUpdated: onEvent, onBlockDeleted: onEvent,
      onOpen: () => {
        void refresh();
        for (const id of tabsRef.current.openTabs) {
          if (!documentWrites.deferLoad(id) && !protectsTab(id)) void loadDocument(id);
        }
      }
    }, vaultId);
    return () => connection.close();
  }, [ready, documentWrites, loadDocument, openPage, patchDraft, protectsTab, refresh, removeTabs, tabsRef, vaultId]);

  useEffect(() => {
    if (!deferredEventsRef.current || movingRef.current) return;
    deferredEventsRef.current = false;
    void refresh();
    for (const id of tabsRef.current.openTabs) {
      if (protectsTab(id)) patchDraft(id, { externalChange: true });
      else void loadDocument(id);
    }
  }, [moveGeneration, loadDocument, patchDraft, protectsTab, refresh, tabsRef]);

  useEffect(() => {
    const unauthorized = (): void => { clearToken(); setTokenOpen(true); };
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
  }, []);

  const changeDraft = useCallback((pageId: string, source: string): void => {
    const document = documentsRef.current[pageId];
    const draft = draftsRef.current[pageId];
    if (!document || source === (draft?.source ?? document.source)) return;
    keepTab(pageId);
    setDrafts((previous) => {
      const base = draft ?? freshDraft(document);
      return { ...previous, [pageId]: { ...base, source, epoch: base.epoch + 1 } };
    });
  }, [documentsRef, draftsRef, keepTab, setDrafts]);

  const discardDraft = useCallback((pageId: string): void => { void loadDocument(pageId, true); }, [loadDocument]);
  const setModalOpen = useCallback((pageId: string, modalOpen: boolean): void => {
    if (modalOpen) keepTab(pageId);
    patchDraft(pageId, { modalOpen });
    const draft = draftsRef.current[pageId];
    if (!modalOpen && draft?.externalChange && !draft.conflict && !isDirty(pageId)) void loadDocument(pageId);
  }, [draftsRef, isDirty, keepTab, loadDocument, patchDraft]);

  const commitDiagram = useCallback(async (pageId: string, write: DiagramWrite): Promise<VaultDocument> => {
    if (movingRef.current) throw new Error('Дождитесь завершения перемещения.');
    keepTab(pageId);
    return documentWrites.enqueue(pageId, async () => {
      const draft = draftsRef.current[pageId];
      if (!draft || draft.epoch !== write.draftEpoch || draft.source !== write.draftSource) {
        throw new Error('Документ изменился после открытия диаграммы. Закройте диалог и повторите действие.');
      }
      if (draft.conflict) throw new Error(draft.conflict);
      try {
        const saved = await writeDocument(pageId, draft, write);
        void refresh();
        return saved;
      } catch (writeError) {
        if (writeError instanceof ApiError && writeError.status === 409) {
          patchDraft(pageId, { conflict: 'Файл или связанная схема изменились вне LiveNote. Черновик диаграммы сохранён в открытом диалоге.' });
        }
        throw writeError;
      }
    });
  }, [documentWrites, draftsRef, keepTab, patchDraft, refresh, writeDocument]);

  const applyMoveResult = useCallback(async (result: VaultMoveResult): Promise<void> => {
    const remap = (path: string): string => remapPath(path, result.moved);
    const previousTabs = tabsRef.current.openTabs;
    const updatedPaths = new Set(result.updatedPaths);
    const reloadPaths = new Set(updatedPaths);
    for (const path of previousTabs) {
      const nextPath = remap(path);
      if (nextPath === path && !updatedPaths.has(path)) continue;
      loadsRef.current.delete(path);
      loadsRef.current.delete(nextPath);
      documentWrites.forget(path);
      reloadPaths.add(nextPath);
    }
    setTabs(previous => remapVaultTabPaths(previous, remap));
    setHistory((previous) => ({ ...previous, entries: previous.entries.map(remap) }));
    setFragmentTarget((target) => target && { ...target, pageId: remap(target.pageId) });
    setFollowTarget((target) => target && { ...target, pageId: remap(target.pageId) });
    const previousDocuments = documentsRef.current;
    setDocuments((previous) => Object.fromEntries(Object.entries(previous).map(([path, document]) => [remap(path),
      result.document && path === result.moved.find((entry) => entry.to === result.document?.path)?.from ? result.document
        : { ...document, path: remap(document.path), page: { ...document.page, id: remap(document.page.id) } }])));
    setDrafts((previous) => Object.fromEntries(Object.entries(previous).map(([path, draft]) => {
      const nextPath = remap(path);
      const movedDocument = result.document && nextPath === result.document.path ? result.document : undefined;
      const document = previousDocuments[path];
      const dirty = document && draft.source !== document.source;
      const changed = nextPath !== path || result.updatedPaths.includes(path) || result.updatedPaths.includes(nextPath);
      if (dirty && changed) return [nextPath, { ...draft, externalChange: true,
        conflict: 'Файл изменился при перемещении. Черновик сохранён; проверьте ссылки перед сохранением.' }];
      return [nextPath, movedDocument ? { ...draft, source: movedDocument.source, baseRevision: movedDocument.page.revision, baseVersion: movedDocument.version } : draft];
    })));
    await refresh();
    for (const path of reloadPaths) if (!protectsTab(path)) void loadDocument(path);
  }, [documentWrites, documentsRef, loadDocument, protectsTab, refresh, setDocuments, setDrafts, setHistory, setTabs, tabsRef]);

  const move = useCallback(async (pageId: string, path: string): Promise<string | null> => {
    const document = documentsRef.current[pageId];
    const file = snapshotRef.current.files.find((item) => item.path === pageId);
    if (tabsRef.current.openTabs.some(protectsTab)) return 'Сохраните черновики и закройте диалоги перед перемещением.';
    if (movingRef.current) return 'Дождитесь завершения перемещения.';
    if (!document && !file) return 'Файл не найден в текущем снимке хранилища.';
    movingRef.current = true;
    setBusy(pageId);
    try {
      const result = await moveVaultPage(pageId, { path,
        expectedRevision: document?.page.revision ?? file?.revision ?? 0,
        expectedVersion: document?.version ?? file?.version ?? '' });
      await applyMoveResult(result);
      return null;
    } catch (moveError) { return message(moveError); } finally { movingRef.current = false; setMoveGeneration((value) => value + 1); setBusy(null); }
  }, [applyMoveResult, documentsRef, protectsTab, snapshotRef, tabsRef]);

  const createDocument = useCallback(async (title: string, path?: string): Promise<string | null> => {
    setBusy('create');
    try {
      const target = path ?? `${selectedFolder ? `${selectedFolder}/` : ''}${title}.md`;
      const page = await createPage({ title, path: target, source: '' });
      await activatePage(page.id, false);
      await refresh();
      return null;
    } catch (createError) { return message(createError); } finally { setBusy(null); }
  }, [activatePage, refresh, selectedFolder]);

  const removeDocument = useCallback(async (pageId: string): Promise<void> => {
    const document = documentsRef.current[pageId];
    const file = snapshotRef.current.files.find((item) => item.path === pageId);
    const revision = document?.page.revision ?? file?.revision;
    if (revision === undefined || protectsTab(pageId)) return;
    try {
      await deletePage(pageId, revision, document?.version ?? file?.version);
      removeTabs([pageId]);
      await refresh();
    } catch (deleteError) { setError(message(deleteError)); }
  }, [documentsRef, protectsTab, refresh, removeTabs, snapshotRef]);

  const createFolder = useCallback(async (path: string): Promise<string | null> => {
    try { const fresh = await createVaultFolder(path, snapshotRef.current.treeVersion); updateSnapshot(() => fresh); setSelectedFolder(path); return null; }
    catch (folderError) { return message(folderError); }
  }, [snapshotRef, updateSnapshot]);
  const moveFolder = useCallback(async (from: string, path: string): Promise<string | null> => {
    if (tabsRef.current.openTabs.some(protectsTab)) return 'Сохраните черновики и закройте диалоги перед перемещением.';
    if (movingRef.current) return 'Дождитесь завершения перемещения.';
    movingRef.current = true;
    try { await applyMoveResult(await moveVaultFolder(from, path, snapshotRef.current.treeVersion)); setSelectedFolder(path); return null; }
    catch (folderError) { return message(folderError); }
    finally { movingRef.current = false; setMoveGeneration((value) => value + 1); }
  }, [applyMoveResult, protectsTab, snapshotRef, tabsRef]);
  const removeFolder = useCallback(async (path: string, recursive: boolean): Promise<void> => {
    try { const fresh = await deleteVaultFolder(path, snapshotRef.current.treeVersion, recursive); updateSnapshot(() => fresh); setSelectedFolder(''); }
    catch (folderError) { setError(message(folderError)); }
  }, [snapshotRef, updateSnapshot]);

  const search = useCallback(async (query: string, tag?: string): Promise<void> => {
    if (!query.trim() && !tag) { setHits(null); return; }
    try { setHits(await searchVault(query, tag)); } catch (searchError) { setError(message(searchError)); }
  }, []);
  const navigateHistory = useCallback((offset: -1 | 1): void => {
    const previous = historyRef.current;
    const index = previous.index + offset;
    const id = previous.entries[index];
    if (id === undefined) return;
    setHistory(() => ({ ...previous, index }));
    openPage(id, true);
  }, [historyRef, openPage, setHistory]);
  const goBack = useCallback((): void => { navigateHistory(-1); }, [navigateHistory]);
  const goForward = useCallback((): void => { navigateHistory(1); }, [navigateHistory]);
  const confirmToken = useCallback((token: string): void => { setToken(token); setTokenOpen(false); void bootstrap(); }, [bootstrap]);

  return {
    snapshot, documents, drafts, openTabs, activeId, previewId, history, hits, ready, unavailable, busy, error, tokenOpen,
    selectedFolder, fragmentTarget, followTarget, tokenRequired: getToken() === null,
    openPage, keepTab, closeTab, closeTabs, splitTab, focusPane, closePane, resizePaneSplit, paneLayout: tabs.layout,
    changeDraft, discardDraft, saveDraft, commitDiagram, setModalOpen, isDirty, move,
    openLinkedPage: (pageId: string, fragment?: string) => { setFragmentTarget(fragment ? { pageId, fragment } : null); openPage(pageId); },
    clearFragmentTarget: () => setFragmentTarget(null), clearFollowTarget: () => setFollowTarget(null), setSelectedFolder,
    createDocument, removeDocument, createFolder, moveFolder, removeFolder, search, goBack, goForward, confirmToken,
    refresh, reload: (pageId: string) => loadDocument(pageId),
    clearError: () => setError(null), showError: (value: string) => setError(value)
  };
}

export type VaultWorkspace = ReturnType<typeof useVaultWorkspace>;
