export type SplitDirection = 'right' | 'down';

interface Pane {
  readonly kind: 'pane';
  readonly id: number;
  readonly path: string | null;
}

interface Split {
  readonly kind: 'split';
  readonly id: number;
  readonly direction: SplitDirection;
  readonly percent: number;
  readonly first: PaneNode;
  readonly second: PaneNode;
}

type PaneNode = Pane | Split;

export const MIN_SPLIT_PERCENT = 20;
export const MAX_SPLIT_PERCENT = 80;

export interface VaultPaneLayout {
  readonly root: PaneNode;
  readonly focused: number;
}

export function vaultPanes(node: PaneNode): readonly Pane[] {
  return node.kind === 'pane' ? [node] : [...vaultPanes(node.first), ...vaultPanes(node.second)];
}

function updatePane(node: PaneNode, id: number, update: (pane: Pane) => PaneNode): PaneNode {
  if (node.kind === 'pane') return node.id === id ? update(node) : node;
  return { ...node, first: updatePane(node.first, id, update), second: updatePane(node.second, id, update) };
}

function maxNodeId(node: PaneNode): number {
  return node.kind === 'pane' ? node.id : Math.max(node.id, maxNodeId(node.first), maxNodeId(node.second));
}

export function splitPane(layout: VaultPaneLayout | undefined, activePath: string | null, path: string,
  openTabs: readonly string[], direction: SplitDirection): VaultPaneLayout {
  const root: PaneNode = layout?.root ?? { kind: 'pane', id: 0, path: activePath };
  const panes = vaultPanes(root);
  const current = panes.find(pane => pane.path === path);
  const source = current?.id ?? layout?.focused ?? 0;
  const displayed = new Set(panes.map(pane => pane.path));
  const nextPath = current ? openTabs.findLast(tab => !displayed.has(tab)) ?? null : path;
  const id = maxNodeId(root) + 1;
  return {
    root: updatePane(root, source, pane => ({
      kind: 'split', id, direction, percent: 50, first: pane, second: { kind: 'pane', id, path: nextPath }
    })),
    focused: id
  };
}

export function resizeSplit(layout: VaultPaneLayout, id: number, percent: number): VaultPaneLayout {
  if (!Number.isFinite(percent)) return layout;
  const bounded = Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, percent));
  function resize(node: PaneNode): PaneNode {
    if (node.kind === 'pane') return node;
    if (node.id === id) return node.percent === bounded ? node : { ...node, percent: bounded };
    const first = resize(node.first);
    const second = resize(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  }
  const root = resize(layout.root);
  return root === layout.root ? layout : { ...layout, root };
}

export function selectPanePath(layout: VaultPaneLayout, path: string): VaultPaneLayout {
  const visible = vaultPanes(layout.root).find(pane => pane.path === path);
  if (visible) return { ...layout, focused: visible.id };
  return { ...layout, root: updatePane(layout.root, layout.focused, pane => ({ ...pane, path })) };
}

export function activePanePath(layout: VaultPaneLayout): string | null {
  return vaultPanes(layout.root).find(pane => pane.id === layout.focused)?.path ?? null;
}

export function prunePanes(layout: VaultPaneLayout, remove: (pane: Pane) => boolean): VaultPaneLayout | undefined {
  function prune(node: PaneNode): PaneNode | null {
    if (node.kind === 'pane') return remove(node) ? null : node;
    const first = prune(node.first);
    const second = prune(node.second);
    return first && second ? { ...node, first, second } : first ?? second;
  }
  const root = prune(layout.root);
  if (!root) return undefined;
  const panes = vaultPanes(root);
  const focused = panes.find(pane => pane.id === layout.focused)
    ?? panes.find(pane => pane.path !== null) ?? panes[0];
  return focused ? { root, focused: focused.id } : undefined;
}

export function remapPanes(layout: VaultPaneLayout, remap: (path: string) => string): VaultPaneLayout {
  function map(node: PaneNode): PaneNode {
    if (node.kind === 'pane') return { ...node, path: node.path === null ? null : remap(node.path) };
    return { ...node, first: map(node.first), second: map(node.second) };
  }
  return { ...layout, root: map(layout.root) };
}

interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PositionedPane extends Pane, PaneRect {}

export interface PositionedSplit extends PaneRect {
  readonly id: number;
  readonly direction: SplitDirection;
  readonly percent: number;
}

export function positionPaneLayout(root?: PaneNode): {
  readonly panes: readonly PositionedPane[];
  readonly splits: readonly PositionedSplit[];
} {
  const panes: PositionedPane[] = [];
  const splits: PositionedSplit[] = [];
  function position(node: PaneNode, x: number, y: number, width: number, height: number): void {
    if (node.kind === 'pane') {
      panes.push({ ...node, x, y, width, height });
      return;
    }
    const { id, direction, percent } = node;
    splits.push({ id, direction, percent, x, y, width, height });
    if (direction === 'right') {
      const firstWidth = width * percent / 100;
      position(node.first, x, y, firstWidth, height);
      position(node.second, x + firstWidth, y, width - firstWidth, height);
    } else {
      const firstHeight = height * percent / 100;
      position(node.first, x, y, width, firstHeight);
      position(node.second, x, y + firstHeight, width, height - firstHeight);
    }
  }
  if (root) position(root, 0, 0, 100, 100);
  return { panes, splits };
}
