import { activePanePath, prunePanes, remapPanes, selectPanePath, splitPane, vaultPanes } from './vaultPaneState';
import type { SplitDirection, VaultPaneLayout } from './vaultPaneState';

export interface VaultTabState {
  readonly openTabs: readonly string[];
  readonly activeId: string | null;
  readonly previewId: string | null;
  readonly layout?: VaultPaneLayout;
}

export function remapVaultTabPaths(state: VaultTabState, remap: (path: string) => string): VaultTabState {
  const { openTabs, activeId, previewId, layout } = state;
  return {
    openTabs: openTabs.map(remap),
    activeId: activeId === null ? null : remap(activeId),
    previewId: previewId === null ? null : remap(previewId),
    ...(layout && { layout: remapPanes(layout, remap) })
  };
}

export function openVaultTab(state: VaultTabState, id: string, canReplacePreview: boolean): VaultTabState {
  if (state.activeId === id) return state;
  const layout = state.layout && selectPanePath(state.layout, id);
  if (state.openTabs.includes(id)) return { ...state, activeId: id, ...(layout && { layout }) };
  const previewId = state.previewId;
  const previewInOtherPane = layout && vaultPanes(layout.root).some(pane => pane.path === previewId && pane.id !== layout.focused);
  const openTabs = previewId !== null && canReplacePreview && !previewInOtherPane
    ? state.openTabs.map((tabId) => tabId === previewId ? id : tabId)
    : [...state.openTabs, id];
  return { openTabs, activeId: id, previewId: id, ...(layout && { layout }) };
}

export function removeVaultTabs(state: VaultTabState, ids: ReadonlySet<string>): VaultTabState {
  const { openTabs, activeId, previewId } = state;
  if (ids.size === 0) return state;
  const remaining = openTabs.filter((id) => !ids.has(id));
  let nextActive = activeId;
  if (activeId !== null && ids.has(activeId)) {
    const activeIndex = openTabs.indexOf(activeId);
    nextActive = openTabs.find((id, index) => index > activeIndex && !ids.has(id)) ?? remaining.at(-1) ?? null;
  }
  const next = { openTabs: remaining, activeId: nextActive, previewId: previewId !== null && ids.has(previewId) ? null : previewId };
  if (!state.layout) return next;
  const layout = prunePanes(state.layout, pane => pane.path !== null && ids.has(pane.path));
  return withLayout(next, layout);
}

function withLayout(state: VaultTabState, layout: VaultPaneLayout | undefined): VaultTabState {
  const activeId = layout ? activePanePath(layout) : null;
  const { layout: _previous, ...tabs } = state;
  if (layout?.root.kind === 'split') return { ...tabs, activeId, layout };
  return { ...tabs, activeId: activeId ?? tabs.activeId ?? tabs.openTabs.at(-1) ?? null };
}

export function splitVaultTab(state: VaultTabState, id: string, direction: SplitDirection): VaultTabState {
  if (!state.openTabs.includes(id)) return state;
  const layout = splitPane(state.layout, state.activeId, id, state.openTabs, direction);
  return withLayout({ ...state, previewId: null }, layout);
}

export function focusVaultPane(state: VaultTabState, id: number): VaultTabState {
  const layout = state.layout;
  if (!layout || layout.focused === id || !vaultPanes(layout.root).some(pane => pane.id === id)) return state;
  return withLayout(state, { ...layout, focused: id });
}

export function closeVaultPane(state: VaultTabState, id: number): VaultTabState {
  if (!state.layout || !vaultPanes(state.layout.root).some(pane => pane.id === id)) return state;
  return withLayout(state, prunePanes(state.layout, pane => pane.id === id));
}
