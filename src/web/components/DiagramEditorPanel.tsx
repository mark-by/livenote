import { useState } from 'react';
import type { DiagramEditor } from './useDiagramEditor';
import { CLASS_RELATIONS } from '../classDiagram';
import type { ClassRelation } from '../classDiagram';
import './flowchartEditor.css';

const relationNames: Record<ClassRelation, string> = {
  '<|--': 'Наследование', '--|>': 'Наследование',
  '*--': 'Композиция', '--*': 'Композиция',
  'o--': 'Агрегация', '--o': 'Агрегация',
  '-->': 'Ассоциация', '<--': 'Ассоциация',
  '--': 'Связь', '..': 'Пунктирная связь',
  '..>': 'Зависимость', '<..': 'Зависимость',
  '..|>': 'Реализация', '<|..': 'Реализация'
};

export function DiagramEditorPanel({ editor }: { editor: DiagramEditor }): React.JSX.Element | null {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [edgeLabel, setEdgeLabel] = useState('');
  const [relation, setRelation] = useState<ClassRelation>('-->');
  const model = editor.model;
  if (!model) return null;
  const isClass = model.kind === 'class';
  const node = editor.selection?.type === 'node'
    ? model.nodes.find(({ id }) => id === editor.selection?.id) : undefined;
  const edge = editor.selection?.type === 'edge'
    ? model.edges.find(({ id }) => id === editor.selection?.id) : undefined;
  const classNode = node?.members !== undefined ? { id: node.id, members: node.members } : null;
  const classEdge = edge?.relation !== undefined ? { id: edge.id, relation: edge.relation } : null;
  const fromId = model.nodes.some(({ id }) => id === from) ? from : model.nodes[0]?.id ?? '';
  const toId = model.nodes.some(({ id }) => id === to) ? to : model.nodes[1]?.id ?? fromId;

  const addNode = (): void => {
    let index = 1;
    while (model.nodes.some(({ id }) => id === `node_${index}`)) index++;
    const id = `node_${index}`;
    editor.edit({ type: 'addNode', id, label: isClass ? 'Новый класс' : 'Новый узел' });
    editor.setSelection({ type: 'node', id });
  };

  return (
    <aside className="flowchart-editor" aria-label={isClass ? 'Редактор классов и отношений' : 'Редактор узлов и связей'}>
      <h2>{isClass ? 'Классы и отношения' : 'Узлы и связи'}</h2>
      <p className="flowchart-editor__hint">
        {isClass ? 'Выберите класс или отношение на схеме либо в списке.' : 'Выберите узел или линию на схеме либо в списке.'}
        {' '}Mermaid рассчитывает расположение автоматически.
      </p>
      <fieldset disabled={editor.saving}>
        <legend>{isClass ? 'Классы' : 'Узлы'}</legend>
        <label>
          {isClass ? 'Выбранный класс' : 'Выбранный узел'}
          <select value={node?.id ?? ''} onChange={(event) =>
            editor.setSelection(event.target.value ? { type: 'node', id: event.target.value } : null)}>
            <option value="">{isClass ? 'Выберите класс' : 'Выберите узел'}</option>
            {model.nodes.map((item) => <option key={item.id} value={item.id}>{item.label} ({item.id})</option>)}
          </select>
        </label>
        {node && (
          <>
            <label>
              {isClass ? 'Подпись класса' : 'Подпись узла'}
              <input value={node.label} onChange={(event) =>
                editor.edit({ type: 'renameNode', id: node.id, label: event.target.value })} />
            </label>
            {classNode && (
              <>
              <div>
                <label htmlFor="class-members">Поля и методы</label>
                <textarea id="class-members" value={editor.memberDrafts[classNode.id]?.text ?? classNode.members.join('\n')}
                  rows={8} spellCheck={false}
                  onChange={(event) => editor.edit({
                    type: 'updateMembers', id: classNode.id, members: event.target.value.split('\n')
                  })} />
              </div>
              <span className="flowchart-editor__hint">Каждое поле или метод — на отдельной строке.</span>
              </>
            )}
            <button className="btn btn--danger" type="button"
              onClick={() => editor.edit({ type: 'removeNode', id: node.id })}>
              {isClass ? 'Удалить класс и его отношения' : 'Удалить узел и его связи'}
            </button>
          </>
        )}
        <button className="btn" type="button" onClick={addNode}>{isClass ? 'Добавить класс' : 'Добавить узел'}</button>
      </fieldset>
      <fieldset disabled={editor.saving}>
        <legend>{isClass ? 'Отношения' : 'Связи'}</legend>
        <label>
          {isClass ? 'Выбранное отношение' : 'Выбранная связь'}
          <select value={edge?.id ?? ''} onChange={(event) =>
            editor.setSelection(event.target.value ? { type: 'edge', id: event.target.value } : null)}>
            <option value="">{isClass ? 'Выберите отношение' : 'Выберите связь'}</option>
            {model.edges.map((item) => (
              <option key={item.id} value={item.id}>{item.from} → {item.to}{item.label ? `: ${item.label}` : ''}</option>
            ))}
          </select>
        </label>
        {edge && (
          <>
            <label>
              {isClass ? 'Подпись отношения' : 'Подпись связи'}
              <input value={edge.label} onChange={(event) =>
                editor.edit({ type: 'updateEdgeLabel', id: edge.id, label: event.target.value })} />
            </label>
            {classEdge && (
              <label>
                Тип отношения
                <select value={classEdge.relation} onChange={(event) => {
                  const value = CLASS_RELATIONS.find((item) => item === event.target.value);
                  if (value) editor.edit({ type: 'updateRelation', id: classEdge.id, relation: value });
                }}>
                  {CLASS_RELATIONS.map((value) => (
                    <option key={value} value={value}>{relationNames[value]} ({value})</option>
                  ))}
                </select>
              </label>
            )}
            <button className="btn btn--danger" type="button"
              onClick={() => editor.edit({ type: 'removeEdge', id: edge.id })}>
              {isClass ? 'Удалить отношение' : 'Удалить связь'}
            </button>
          </>
        )}
      </fieldset>
      <form onSubmit={(event) => {
        event.preventDefault();
        editor.edit({ type: 'addEdge', from: fromId, to: toId, label: edgeLabel, relation });
      }}>
        <fieldset disabled={editor.saving || model.nodes.length === 0}>
          <legend>{isClass ? 'Новое отношение' : 'Новая связь'}</legend>
          <label>
            {isClass ? 'От класса' : 'От узла'}
            <select value={fromId} onChange={(event) => setFrom(event.target.value)}>
              {model.nodes.map((item) => <option key={item.id} value={item.id}>{item.label} ({item.id})</option>)}
            </select>
          </label>
          <label>
            {isClass ? 'К классу' : 'К узлу'}
            <select value={toId} onChange={(event) => setTo(event.target.value)}>
              {model.nodes.map((item) => <option key={item.id} value={item.id}>{item.label} ({item.id})</option>)}
            </select>
          </label>
          {isClass && (
            <label>
              Тип нового отношения
              <select value={relation} onChange={(event) => {
                const value = CLASS_RELATIONS.find((item) => item === event.target.value);
                if (value) setRelation(value);
              }}>
                {CLASS_RELATIONS.map((value) => (
                  <option key={value} value={value}>{relationNames[value]} ({value})</option>
                ))}
              </select>
            </label>
          )}
          <label>
            {isClass ? 'Подпись нового отношения' : 'Подпись новой связи'}
            <input value={edgeLabel} onChange={(event) => setEdgeLabel(event.target.value)} />
          </label>
          <button className="btn" type="submit">{isClass ? 'Добавить отношение' : 'Добавить связь'}</button>
        </fieldset>
      </form>
      {editor.error && (
        <div className="flowchart-editor__error" role="alert">
          {editor.error}
          <details><summary>Исходник черновика</summary><textarea aria-label="Исходник черновика" readOnly value={editor.source} /></details>
        </div>
      )}
    </aside>
  );
}
