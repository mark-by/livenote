import type { VaultDocument, VaultMoveResult } from '../../shared/types';
import type { VaultDraft } from './vaultDocumentWrites';
import { remapPath } from './vaultPaths';
import { remapVaultTabPaths } from './vaultTabState';
import type { VaultTabState } from './vaultTabState';

export interface HistoryState { readonly entries: readonly string[]; readonly index: number }
export interface FragmentTarget { readonly pageId: string; readonly fragment: string }
export type FollowTarget = { readonly pageId: string; readonly version: string }
  & ({ readonly position: number } | { readonly line: number });

interface MoveState {
  readonly tabs: VaultTabState;
  readonly history: HistoryState;
  readonly documents: Readonly<Record<string, VaultDocument>>;
  readonly drafts: Readonly<Record<string, VaultDraft>>;
  readonly fragmentTarget: FragmentTarget | null;
  readonly followTarget: FollowTarget | null;
}

export function isVaultDraftDirty(draft: VaultDraft | undefined, document: VaultDocument | undefined): boolean {
  return draft !== undefined && draft.source !== document?.source;
}

export function relocateVaultWorkspace(state: MoveState, result: VaultMoveResult) {
  const remap = (path: string): string => remapPath(path, result.moved);
  const updated = new Set(result.updatedPaths);
  const movedDocument = result.document;
  const reloadPaths = new Set(updated);
  const invalidatedLoads = new Set<string>();
  const invalidatedWrites = new Set<string>();
  for (const path of state.tabs.openTabs) {
    const nextPath = remap(path);
    if (nextPath === path && !updated.has(path)) continue;
    invalidatedLoads.add(path);
    invalidatedLoads.add(nextPath);
    invalidatedWrites.add(path);
    reloadPaths.add(nextPath);
  }

  function remapTarget<T extends { readonly pageId: string }>(target: T | null): T | null {
    return target === null ? null : { ...target, pageId: remap(target.pageId) };
  }

  const documents = Object.fromEntries(Object.entries(state.documents).map(([path, document]) => {
    const nextPath = remap(path);
    return [nextPath, movedDocument?.path === nextPath ? movedDocument
      : { ...document, path: remap(document.path), page: { ...document.page, id: remap(document.page.id) } }];
  }));
  const drafts = Object.fromEntries(Object.entries(state.drafts).map(([path, draft]) => {
    const nextPath = remap(path);
    const changed = nextPath !== path || updated.has(path) || updated.has(nextPath);
    if (changed && isVaultDraftDirty(draft, state.documents[path])) {
      return [nextPath, { ...draft, externalChange: true,
        conflict: 'Файл изменился при перемещении. Черновик сохранён; проверьте ссылки перед сохранением.' }];
    }
    if (movedDocument?.path === nextPath) {
      return [nextPath, { ...draft, source: movedDocument.source, baseRevision: movedDocument.page.revision, baseVersion: movedDocument.version }];
    }
    return [nextPath, draft];
  }));

  return {
    tabs: remapVaultTabPaths(state.tabs, remap),
    history: { ...state.history, entries: state.history.entries.map(remap) },
    fragmentTarget: remapTarget(state.fragmentTarget),
    followTarget: remapTarget(state.followTarget),
    documents, drafts, invalidatedLoads, invalidatedWrites, reloadPaths
  };
}
