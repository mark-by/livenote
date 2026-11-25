import type { AgentTarget, SourceRange, VaultDocument } from '../../shared/types';
import type { DiagramAgentEditor, DiagramSession, DiagramValue } from '../diagrams/types';
import type { DiagramWrite, VaultDraft } from './vaultDocumentWrites';
import { formatForPath, insertBlockAt, mermaidFence, nextAssetPath, relativeVaultPath } from './vaultPaths';

export interface DiagramContext {
  readonly session: DiagramSession;
  readonly range: SourceRange;
  readonly draftEpoch: number;
  readonly draftSource: string;
  readonly asset?: { path: string; version: string | null };
}

export interface OpenAgentDiagram extends DiagramContext {
  readonly path: string;
  readonly capture: DiagramAgentEditor['capture'];
  readonly reload: (document: VaultDocument, draft: VaultDraft, target: AgentTarget) => void;
}

/** Сохранение и захват используют один исходник и одну цель. */
export function prepareDiagramWrite(
  path: string, draft: VaultDraft, context: DiagramContext, value: DiagramValue, filePaths: string[]
): { write: DiagramWrite; target: AgentTarget; edit?: { from: number; to: number; text: string } } {
  if (draft.epoch !== context.draftEpoch || draft.source !== context.draftSource) {
    throw new Error('Документ изменился. Закройте диалог и откройте схему снова.');
  }
  const base = { draftEpoch: draft.epoch, draftSource: draft.source };
  const asset = context.asset ?? (context.session.mode === 'create' && value.format !== 'mermaid'
    ? { path: nextAssetPath(path, value.format, filePaths), version: null } : undefined);
  if (asset) {
    const assets = [{ path: asset.path, source: value.source, expectedVersion: asset.version }];
    const target = { kind: 'asset', path: asset.path } as const;
    if (context.session.mode !== 'create') return { write: { ...base, source: draft.source, assets }, target };
    const embed = `![[${relativeVaultPath(path, asset.path)}|${value.title ?? 'Схема'}]]`;
    const { source, edit } = insertBlockAt(draft.source, context.range.from, embed);
    return { write: { ...base, source, assets }, target, edit };
  }
  if (formatForPath(path) === value.format) return { write: { ...base, source: value.source }, target: { kind: 'file' } };
  const text = mermaidFence(value.source);
  const { from, to } = context.range;
  if (context.session.mode === 'create') {
    const inserted = insertBlockAt(draft.source, from, text);
    const target = { kind: 'inline', from: inserted.from, to: inserted.to } as const;
    return { write: { ...base, source: inserted.source }, target, edit: inserted.edit };
  }
  const source = `${draft.source.slice(0, from)}${text}${draft.source.slice(to)}`;
  return { write: { ...base, source }, target: { kind: 'inline', from, to: from + text.length }, edit: { from, to, text } };
}
