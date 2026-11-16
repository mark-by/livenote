import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import type { Block } from '../../shared/types';
import { ApiError, updateBlock } from '../api';
import { applyFlowchartEdit, readFlowchart } from '../flowchart';
import type { FlowchartEdit, FlowchartEdge, FlowchartModel, FlowchartNode } from '../flowchart';
import { applyClassDiagramEdit, readClassDiagram } from '../classDiagram';
import type { ClassDiagramEdit, ClassRelation } from '../classDiagram';
import { useConfirm } from './ConfirmDialog';

export type DiagramSelection = { type: 'node' | 'edge'; id: string } | null;

interface EditableDiagramModel extends FlowchartModel {
  kind: 'flowchart' | 'class';
  nodes: (FlowchartNode & { members?: string[] })[];
  edges: (FlowchartEdge & { relation?: ClassRelation })[];
}

interface EditorProps {
  block: Block;
  pageRevision: number;
  onSaved(source: string, revision: number): void;
  onClose(): void;
}

/** Черновик хранит исходную ревизию до успешной записи. SSE не заменяет его. */
export function useDiagramEditor({ block, pageRevision, onSaved, onClose }: EditorProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [selection, setSelection] = useState<DiagramSelection>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberDrafts, setMemberDrafts] = useState<Record<string, { text: string; error: string | null }>>({});
  const { confirm, dialog } = useConfirm();
  const source = draft ?? block.source;
  const model = useMemo<EditableDiagramModel | null>(() => {
    if (block.type !== 'mermaid') return null;
    const classes = readClassDiagram(source);
    if (classes) return { ...classes, kind: 'class' as const };
    const flowchart = readFlowchart(source);
    return flowchart ? { ...flowchart, kind: 'flowchart' as const } : null;
  }, [block.type, source]);
  const editing = draft !== null;
  const memberError = Object.values(memberDrafts).find((value) => value.error !== null)?.error ?? null;
  const dirty = editing && (draft !== block.source || memberError !== null);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const leave = async (close: boolean): Promise<void> => {
    if (saving || dialog !== null) return;
    if (dirty) {
      const discard = await confirm({
        title: 'Отменить изменения?',
        message: 'Изменения диаграммы ещё не сохранены.',
        confirmLabel: 'Отменить изменения',
        danger: true
      });
      if (!discard) return;
    }
    setDraft(null);
    setMemberDrafts({});
    setSelection(null);
    setError(null);
    if (close) onClose();
  };

  const edit = (change: FlowchartEdit | ClassDiagramEdit): void => {
    if (!editing || saving) return;
    if (change.type === 'removeNode' && model?.nodes.length === 1) {
      setError(model.kind === 'class'
        ? 'В диаграмме должен остаться хотя бы один класс.'
        : 'В диаграмме должен остаться хотя бы один узел.');
      return;
    }
    try {
      if (model?.kind === 'class') {
        setDraft(applyClassDiagramEdit(source, change));
      } else if (change.type !== 'updateMembers' && change.type !== 'updateRelation') {
        setDraft(applyFlowchartEdit(source, change));
      }
      if (change.type === 'updateMembers') {
        const value = { text: change.members.join('\n'), error: null };
        setMemberDrafts((previous) => ({ ...previous, [change.id]: value }));
      } else if (change.type === 'removeNode') {
        setMemberDrafts((previous) => {
          const remaining = { ...previous };
          delete remaining[change.id];
          return remaining;
        });
      }
      setError(null);
      if (change.type === 'removeNode' || change.type === 'removeEdge') setSelection(null);
    } catch (editError) {
      const message = editError instanceof Error ? editError.message : String(editError);
      if (change.type === 'updateMembers') {
        const value = { text: change.members.join('\n'), error: message };
        setMemberDrafts((previous) => ({ ...previous, [change.id]: value }));
      } else {
        setError(message);
      }
    }
  };

  const save = async (): Promise<void> => {
    if (!dirty || saving || memberError !== null) return;
    setSaving(true);
    setError(null);
    try {
      const body = { source, expectedRevision: pageRevision };
      const result = await updateBlock(block.pageId, block.id, body);
      if (result.validation?.syntax === 'error') {
        setError(result.validation.error?.message ?? 'Mermaid отклонил изменения.');
        return;
      }
      onSaved(source, result.revision);
      setDraft(null);
      setMemberDrafts({});
      setSelection(null);
    } catch (saveError) {
      setError(saveError instanceof ApiError && saveError.code === 'conflict'
        ? 'Страница изменилась на сервере. Черновик сохранён в редакторе. Скопируйте его перед повторным открытием диаграммы.'
        : saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const start = (): void => {
    setDraft(block.source);
    setMemberDrafts({});
    setError(null);
    setSelection(null);
  };

  const selectFromDiagram = (event: MouseEvent<HTMLDivElement>): void => {
    if (!editing || saving || !model || !(event.target instanceof Element)) return;
    const node = event.target.closest('.node');
    if (node) {
      const match = model.nodes.find(({ id }) => matchesNode(node, id));
      if (match) setSelection({ type: 'node', id: match.id });
      return;
    }
    const path = event.target.closest('.flowchart-link, path.relation');
    const host = event.currentTarget;
    const index = path ? Array.from(host.querySelectorAll('.flowchart-link, path.relation')).indexOf(path) : -1;
    const edge = model.edges[index];
    if (edge) setSelection({ type: 'edge', id: edge.id });
  };

  const decorate = (host: HTMLElement): void => {
    host.querySelectorAll('.node').forEach((node) => {
      const selected = selection?.type === 'node' &&
        matchesNode(node, selection.id);
      node.classList.toggle('flowchart-selected', editing && selected);
    });
    host.querySelectorAll('.flowchart-link, path.relation').forEach((path, index) => {
      path.classList.toggle('flowchart-selected',
        editing && selection?.type === 'edge' && model?.edges[index]?.id === selection.id);
    });
  };

  return {
    source, model, editing, dirty, saving, error: memberError ?? error, memberDrafts, selection, dialog,
    start, edit, save, selectFromDiagram, decorate, setSelection,
    cancel: () => leave(false),
    close: () => leave(true)
  };
}

function matchesNode(node: Element, id: string): boolean {
  const prefix = node.id.slice(0, node.id.lastIndexOf('-'));
  return node.getAttribute('data-id') === id ||
    prefix.endsWith(`-flowchart-${id}`) || prefix.endsWith(`-classId-${id}`);
}

export type DiagramEditor = ReturnType<typeof useDiagramEditor>;
