export interface VaultTabState {
  readonly openTabs: readonly string[];
  readonly activeId: string | null;
  readonly previewId: string | null;
}

export function openVaultTab(state: VaultTabState, id: string, canReplacePreview: boolean): VaultTabState {
  if (state.openTabs.includes(id)) return state.activeId === id ? state : { ...state, activeId: id };
  const previewId = state.previewId;
  const openTabs = previewId !== null && canReplacePreview
    ? state.openTabs.map((tabId) => tabId === previewId ? id : tabId)
    : [...state.openTabs, id];
  return { openTabs, activeId: id, previewId: id };
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
  return { openTabs: remaining, activeId: nextActive, previewId: previewId !== null && ids.has(previewId) ? null : previewId };
}
