import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEvent, VaultDocument, VaultMoveResult, VaultSearchHit, VaultSnapshot, WriteVaultDocumentBody } from '../../shared/types';
import {
  ApiError, clearToken, createPage, createVaultFolder, deletePage, deleteVaultFolder, getToken,
  getVaultDocument, getVaultSnapshot, moveVaultFolder, moveVaultPage, putVaultDocument,
  searchVault, setToken, UNAUTHORIZED_EVENT
} from '../api';
import { connectEvents } from '../events';
import { remapPath } from './vaultPaths';

const STORAGE_TABS = 'livenote_open_tabs';
const STORAGE_ACTIVE = 'livenote_active_tab';
const EMPTY_SNAPSHOT: VaultSnapshot = { pages: [], files: [], folders: [''], treeVersion: '', tags: [], problems: [] };

export interface VaultDraft {
  readonly source: string;
  readonly baseRevision: number;
  readonly baseVersion: string;
  readonly epoch: number;
  readonly saving: boolean;
  readonly modalOpen: boolean;
  readonly externalChange: boolean;
  readonly conflict: string | null;
}

export interface DiagramWrite {
  readonly draftEpoch: number;
  readonly draftSource: string;
  readonly source: string;
  readonly assets?: WriteVaultDocumentBody['assets'];
  readonly references?: WriteVaultDocumentBody['references'];
}

interface HistoryState { readonly entries: string[]; readonly index: number }

function loadTabs(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_TABS) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function freshDraft(document: VaultDocument): VaultDraft {
  return { source: document.source, baseRevision: document.page.revision, baseVersion: document.version,
    epoch: 0, saving: false, modalOpen: false, externalChange: false, conflict: null };
}

/** Состояние vault: path-based документы, последовательные сохранения, вкладки и файловые операции. */
export function useVaultWorkspace(tokenRequired: boolean) {
  const [snapshot, setSnapshot] = useState<VaultSnapshot>(EMPTY_SNAPSHOT);
  const [documents, setDocuments] = useState<Record<string, VaultDocument>>({});
  const [drafts, setDrafts] = useState<Record<string, VaultDraft>>({});
  const [openTabs, setOpenTabs] = useState<string[]>(loadTabs);
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(STORAGE_ACTIVE));
  const [history, setHistory] = useState<HistoryState>({ entries: [], index: -1 });
  const [hits, setHits] = useState<VaultSearchHit[] | null>(null);
  const [ready, setReady] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(tokenRequired && getToken() === null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [fragmentTarget, setFragmentTarget] = useState<{ pageId: string; fragment: string } | null>(null);
  const [moveGeneration, setMoveGeneration] = useState(0);

  const documentsRef = useRef(documents);
  const draftsRef = useRef(drafts);
  const snapshotRef = useRef(snapshot);
  const tabsRef = useRef(openTabs);
  const activeRef = useRef(activeId);
  const sequenceRef = useRef(new Map<string, number>());
  const saveChains = useRef(new Map<string, Promise<void>>());
  const inflightRef = useRef(new Map<string, number>());
  const ownRevisionsRef = useRef(new Map<string, Set<number>>());
  const movingRef = useRef(false);
  const deferredEventsRef = useRef(false);
  documentsRef.current = documents;
  draftsRef.current = drafts;
  snapshotRef.current = snapshot;
  tabsRef.current = openTabs;
  activeRef.current = activeId;

  useEffect(() => localStorage.setItem(STORAGE_TABS, JSON.stringify(openTabs)), [openTabs]);
  useEffect(() => { if (activeId !== null) localStorage.setItem(STORAGE_ACTIVE, activeId); }, [activeId]);

  const isDirty = useCallback((pageId: string): boolean => {
    const draft = draftsRef.current[pageId];
    const document = documentsRef.current[pageId];
    return draft !== undefined && (document === undefined || draft.source !== document.source);
  }, []);

  const patchDraft = useCallback((pageId: string, patch: Partial<VaultDraft>): void => {
    setDrafts((previous) => previous[pageId] ? { ...previous, [pageId]: { ...previous[pageId], ...patch } } : previous);
  }, []);

  const loadDocument = useCallback(async (pageId: string, discard = false): Promise<void> => {
    const sequence = (sequenceRef.current.get(pageId) ?? 0) + 1;
    sequenceRef.current.set(pageId, sequence);
    try {
      const document = await getVaultDocument(pageId);
      if (sequenceRef.current.get(pageId) !== sequence) return;
      setDocuments((previous) => ({ ...previous, [pageId]: document }));
      const hadDocument = documentsRef.current[pageId] !== undefined;
      setDrafts((previous) => {
        const draft = previous[pageId];
        if (discard) return { ...previous, [pageId]: freshDraft(document) };
        if (!draft) return hadDocument ? previous : { ...previous, [pageId]: freshDraft(document) };
        if (document.version !== draft.baseVersion && !draft.saving) {
          if (!draft.modalOpen && !isDirty(pageId)) return { ...previous, [pageId]: freshDraft(document) };
          return { ...previous, [pageId]: { ...draft, externalChange: true } };
        }
        return previous;
      });
    } catch (loadError) {
      if (sequenceRef.current.get(pageId) === sequence) {
        if (loadError instanceof ApiError && loadError.status === 404 && isDirty(pageId)) {
          patchDraft(pageId, { conflict: 'Файл удалён или перемещён вне LiveNote. Черновик оставлен без изменений.', externalChange: true });
        } else setError(message(loadError));
      }
    }
  }, [isDirty, patchDraft]);

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    try {
      const fresh = await getVaultSnapshot();
      setSnapshot(fresh);
      setOpenTabs((previous) => previous.filter((id) => fresh.files.some((file) => file.path === id) || isDirty(id)));
      setActiveId((current) => current !== null && !fresh.files.some((file) => file.path === current) && !isDirty(current) ? null : current);
    } catch (loadError) { setError(message(loadError)); }
  }, [isDirty]);

  const openPage = useCallback((pageId: string, fromHistory = false): void => {
    if (!tabsRef.current.includes(pageId)) setOpenTabs((previous) => [...previous, pageId]);
    setActiveId(pageId);
    if (!fromHistory && activeRef.current !== pageId) {
      setHistory((previous) => {
        const entries = [...previous.entries.slice(0, previous.index + 1), pageId];
        return { entries, index: entries.length - 1 };
      });
    }
    if (!documentsRef.current[pageId]) void loadDocument(pageId);
  }, [loadDocument]);

  const closeTab = useCallback((pageId: string): void => {
    const next = tabsRef.current.filter((id) => id !== pageId);
    setOpenTabs(next);
    if (activeRef.current === pageId) setActiveId(next.at(-1) ?? null);
    setDocuments((previous) => { const copy = { ...previous }; delete copy[pageId]; return copy; });
    setDrafts((previous) => { const copy = { ...previous }; delete copy[pageId]; return copy; });
  }, []);

  const saveDraft = useCallback((pageId: string): Promise<void> => {
    const previous = saveChains.current.get(pageId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const draft = draftsRef.current[pageId];
      if (!draft || draft.conflict || draft.modalOpen) return;
      const document = documentsRef.current[pageId];
      if (document && draft.source === document.source) return;
      const captured = draft;
      patchDraft(pageId, { saving: true });
      inflightRef.current.set(pageId, (inflightRef.current.get(pageId) ?? 0) + 1);
      setBusy(pageId);
      try {
        const saved = await putVaultDocument(pageId, {
          expectedRevision: captured.baseRevision, expectedVersion: captured.baseVersion, source: captured.source
        });
        const own = ownRevisionsRef.current.get(pageId) ?? new Set<number>();
        own.add(saved.page.revision);
        ownRevisionsRef.current.set(pageId, own);
        setDocuments((current) => ({ ...current, [pageId]: saved }));
        setDrafts((current) => {
          const latest = current[pageId];
          if (!latest) return current;
          return { ...current, [pageId]: { ...latest, baseRevision: saved.page.revision,
            baseVersion: saved.version, saving: false, externalChange: false, conflict: null } };
        });
        void refreshSnapshot();
      } catch (saveError) {
        setDrafts((current) => {
          const latest = current[pageId];
          if (!latest) return current;
          const conflict = saveError instanceof ApiError && saveError.status === 409;
          return { ...current, [pageId]: { ...latest, saving: false, conflict: conflict
            ? 'Документ изменился вне этого редактора. Автосохранение остановлено; черновик и история редактирования сохранены.'
            : message(saveError) } };
        });
      } finally {
        inflightRef.current.set(pageId, Math.max(0, (inflightRef.current.get(pageId) ?? 1) - 1));
        setBusy(null);
      }
    });
    saveChains.current.set(pageId, next);
    return next;
  }, [patchDraft, refreshSnapshot]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const [pageId, draft] of Object.entries(drafts)) {
        const document = documents[pageId];
        if (document && draft.source !== document.source && !draft.saving && !draft.modalOpen && !draft.conflict) void saveDraft(pageId);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [drafts, documents, saveDraft]);

  useEffect(() => {
    void getVaultSnapshot().then(async (fresh) => {
      setSnapshot(fresh);
      const accessible = tabsRef.current.filter((id) => fresh.files.some((file) => file.path === id));
      setOpenTabs(accessible);
      const initial = activeRef.current && accessible.includes(activeRef.current)
        ? activeRef.current : accessible[0] ?? fresh.files.find((file) => file.kind === 'markdown')?.path ?? fresh.files[0]?.path ?? null;
      if (initial) { openPage(initial); await loadDocument(initial); }
      setReady(true);
    }).catch((bootstrapError: unknown) => { setError(message(bootstrapError)); setReady(true); });
  }, [loadDocument, openPage]);

  useEffect(() => {
    if (!ready) return;
    const onEvent = (event: LiveEvent): void => {
      if (movingRef.current) { deferredEventsRef.current = true; return; }
      void refreshSnapshot();
      if (event.event === 'page.deleted') {
        if (isDirty(event.pageId)) patchDraft(event.pageId, { conflict: 'Файл удалён вне LiveNote. Черновик сохранён.', externalChange: true });
        else closeTab(event.pageId);
        return;
      }
      const own = ownRevisionsRef.current.get(event.pageId);
      if (own?.delete(event.revision)) return;
      if ((inflightRef.current.get(event.pageId) ?? 0) > 0) {
        patchDraft(event.pageId, { externalChange: true });
        return;
      }
      const draft = draftsRef.current[event.pageId];
      if (draft && (isDirty(event.pageId) || draft.modalOpen || draft.saving)) {
        patchDraft(event.pageId, { externalChange: true });
      } else if (tabsRef.current.includes(event.pageId)) void loadDocument(event.pageId);
    };
    const connection = connectEvents({
      onPageCreated: onEvent, onPageUpdated: onEvent, onPageDeleted: onEvent,
      onPageMoved: onEvent, onVaultUpdated: () => { if (movingRef.current) deferredEventsRef.current = true; else void refreshSnapshot(); },
      onBlockCreated: onEvent, onBlockUpdated: onEvent, onBlockDeleted: onEvent,
      onOpen: () => { void refreshSnapshot(); for (const id of tabsRef.current) if (!isDirty(id)) void loadDocument(id); }
    });
    return () => connection.close();
  }, [ready, closeTab, isDirty, loadDocument, patchDraft, refreshSnapshot]);

  useEffect(() => {
    if (!deferredEventsRef.current || movingRef.current) return;
    deferredEventsRef.current = false;
    void refreshSnapshot();
    for (const id of tabsRef.current) {
      if (isDirty(id)) patchDraft(id, { externalChange: true });
      else void loadDocument(id);
    }
  }, [moveGeneration, isDirty, loadDocument, patchDraft, refreshSnapshot]);

  useEffect(() => {
    const unauthorized = (): void => { clearToken(); setTokenOpen(true); };
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
  }, []);

  const changeDraft = useCallback((pageId: string, source: string): void => {
    setDrafts((previous) => {
      const draft = previous[pageId];
      if (draft) return { ...previous, [pageId]: { ...draft, source, epoch: draft.epoch + 1 } };
      const document = documentsRef.current[pageId];
      return document ? { ...previous, [pageId]: { ...freshDraft(document), source, epoch: 1 } } : previous;
    });
  }, []);

  const discardDraft = useCallback((pageId: string): void => { void loadDocument(pageId, true); }, [loadDocument]);
  const setModalOpen = useCallback((pageId: string, modalOpen: boolean): void => { patchDraft(pageId, { modalOpen }); }, [patchDraft]);

  const commitDiagram = useCallback(async (pageId: string, write: DiagramWrite): Promise<VaultDocument> => {
    const previous = saveChains.current.get(pageId) ?? Promise.resolve();
    let result: VaultDocument | null = null;
    const next = previous.then(async () => {
      const draft = draftsRef.current[pageId];
      if (!draft || draft.epoch !== write.draftEpoch || draft.source !== write.draftSource) {
        throw new Error('Документ изменился после открытия диаграммы. Закройте диалог и повторите действие.');
      }
      if (draft.conflict) throw new Error(draft.conflict);
      patchDraft(pageId, { saving: true });
      inflightRef.current.set(pageId, (inflightRef.current.get(pageId) ?? 0) + 1);
      try {
        const saved = await putVaultDocument(pageId, {
          expectedRevision: draft.baseRevision, expectedVersion: draft.baseVersion, source: write.source,
          ...(write.assets ? { assets: write.assets } : {}), ...(write.references ? { references: write.references } : {})
        });
        const own = ownRevisionsRef.current.get(pageId) ?? new Set<number>();
        own.add(saved.page.revision);
        ownRevisionsRef.current.set(pageId, own);
        result = saved;
        setDocuments((current) => ({ ...current, [pageId]: saved }));
        setDrafts((current) => current[pageId] ? { ...current, [pageId]: { ...current[pageId],
          source: saved.source, baseRevision: saved.page.revision, baseVersion: saved.version,
          epoch: current[pageId].epoch + 1, saving: false, externalChange: false, conflict: null } } : current);
        void refreshSnapshot();
      } catch (writeError) {
        patchDraft(pageId, {
          saving: false,
          ...(writeError instanceof ApiError && writeError.status === 409 ? {
            conflict: 'Файл или связанная схема изменились вне LiveNote. Черновик диаграммы сохранён в открытом диалоге.'
          } : {})
        });
        throw writeError;
      } finally {
        inflightRef.current.set(pageId, Math.max(0, (inflightRef.current.get(pageId) ?? 1) - 1));
      }
    });
    saveChains.current.set(pageId, next.catch(() => undefined));
    await next;
    if (!result) throw new Error('Сервер не вернул сохранённый документ.');
    return result;
  }, [patchDraft, refreshSnapshot]);

  const applyMoveResult = useCallback(async (result: VaultMoveResult): Promise<void> => {
    const remap = (path: string): string => remapPath(path, result.moved);
    setOpenTabs((previous) => previous.map(remap));
    setHistory((previous) => ({ ...previous, entries: previous.entries.map(remap) }));
    if (activeRef.current) setActiveId(remap(activeRef.current));
    setDocuments((previous) => Object.fromEntries(Object.entries(previous).map(([path, document]) => [remap(path),
      result.document && path === result.moved.find((entry) => entry.to === result.document?.path)?.from ? result.document
        : { ...document, path: remap(document.path), page: { ...document.page, id: remap(document.page.id) } }])));
    setDrafts((previous) => Object.fromEntries(Object.entries(previous).map(([path, draft]) => {
      const nextPath = remap(path);
      const movedDocument = result.document && nextPath === result.document.path ? result.document : undefined;
      const document = documentsRef.current[path];
      const dirty = document && draft.source !== document.source;
      const changed = nextPath !== path || result.updatedPaths.includes(path) || result.updatedPaths.includes(nextPath);
      if (dirty && changed) return [nextPath, { ...draft, externalChange: true,
        conflict: 'Файл изменился при перемещении. Черновик сохранён; проверьте ссылки перед сохранением.' }];
      return [nextPath, movedDocument ? { ...draft, source: movedDocument.source, baseRevision: movedDocument.page.revision, baseVersion: movedDocument.version } : draft];
    })));
    await refreshSnapshot();
    for (const path of result.updatedPaths) if (!isDirty(path)) void loadDocument(path);
  }, [isDirty, loadDocument, refreshSnapshot]);

  const move = useCallback(async (pageId: string, path: string): Promise<string | null> => {
    const document = documentsRef.current[pageId];
    const file = snapshotRef.current.files.find((item) => item.path === pageId);
    if (Object.keys(draftsRef.current).some(isDirty)) return 'Сначала дождитесь сохранения всех черновиков.';
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
  }, [applyMoveResult, isDirty]);

  const createDocument = useCallback(async (title: string, path?: string): Promise<string | null> => {
    setBusy('create');
    try {
      const target = path ?? `${selectedFolder ? `${selectedFolder}/` : ''}${title}.md`;
      const page = await createPage({ title, path: target, source: '' });
      openPage(page.id);
      await loadDocument(page.id);
      await refreshSnapshot();
      return null;
    } catch (createError) { return message(createError); } finally { setBusy(null); }
  }, [loadDocument, openPage, refreshSnapshot, selectedFolder]);

  const removeDocument = useCallback(async (pageId: string): Promise<void> => {
    const document = documentsRef.current[pageId];
    const file = snapshotRef.current.files.find((item) => item.path === pageId);
    const revision = document?.page.revision ?? file?.revision;
    if (revision === undefined || isDirty(pageId)) return;
    try {
      await deletePage(pageId, revision, document?.version ?? file?.version);
      closeTab(pageId);
      await refreshSnapshot();
    } catch (deleteError) { setError(message(deleteError)); }
  }, [closeTab, isDirty, refreshSnapshot]);

  const createFolder = useCallback(async (path: string): Promise<string | null> => {
    try { setSnapshot(await createVaultFolder(path, snapshotRef.current.treeVersion)); setSelectedFolder(path); return null; }
    catch (folderError) { return message(folderError); }
  }, []);
  const moveFolder = useCallback(async (from: string, path: string): Promise<string | null> => {
    if (Object.keys(draftsRef.current).some(isDirty)) return 'Сначала дождитесь сохранения всех черновиков.';
    if (movingRef.current) return 'Дождитесь завершения перемещения.';
    movingRef.current = true;
    try { await applyMoveResult(await moveVaultFolder(from, path, snapshotRef.current.treeVersion)); setSelectedFolder(path); return null; }
    catch (folderError) { return message(folderError); }
    finally { movingRef.current = false; setMoveGeneration((value) => value + 1); }
  }, [applyMoveResult, isDirty]);
  const removeFolder = useCallback(async (path: string, recursive: boolean): Promise<void> => {
    try { setSnapshot(await deleteVaultFolder(path, snapshotRef.current.treeVersion, recursive)); setSelectedFolder(''); }
    catch (folderError) { setError(message(folderError)); }
  }, []);

  const search = useCallback(async (query: string, tag?: string): Promise<void> => {
    if (!query.trim() && !tag) { setHits(null); return; }
    try { setHits(await searchVault(query, tag)); } catch (searchError) { setError(message(searchError)); }
  }, []);
  const goBack = useCallback((): void => {
    setHistory((previous) => { const index = Math.max(0, previous.index - 1); const id = previous.entries[index];
      if (id) openPage(id, true); return { ...previous, index }; });
  }, [openPage]);
  const goForward = useCallback((): void => {
    setHistory((previous) => { const index = Math.min(previous.entries.length - 1, previous.index + 1); const id = previous.entries[index];
      if (id) openPage(id, true); return { ...previous, index }; });
  }, [openPage]);
  const bootstrap = useCallback(async (): Promise<void> => { await refreshSnapshot(); setReady(true); }, [refreshSnapshot]);
  const confirmToken = useCallback((token: string): void => { setToken(token); setTokenOpen(false); void bootstrap(); }, [bootstrap]);

  return {
    snapshot, documents, drafts, openTabs, activeId, history, hits, ready, busy, error, tokenOpen,
    selectedFolder, fragmentTarget, tokenRequired: getToken() === null,
    openPage, closeTab, changeDraft, discardDraft, saveDraft, commitDiagram, setModalOpen, isDirty, move,
    openLinkedPage: (pageId: string, fragment?: string) => { setFragmentTarget(fragment ? { pageId, fragment } : null); openPage(pageId); },
    clearFragmentTarget: () => setFragmentTarget(null), setSelectedFolder,
    createDocument, removeDocument, createFolder, moveFolder, removeFolder, search, goBack, goForward, confirmToken,
    refresh: () => refreshSnapshot(), reload: (pageId: string) => loadDocument(pageId),
    clearError: () => setError(null), showError: (value: string) => setError(value)
  };
}

export type VaultWorkspace = ReturnType<typeof useVaultWorkspace>;
