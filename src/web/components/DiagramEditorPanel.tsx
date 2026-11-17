import { useState } from 'react';
import { Button, Input, Label, ListBox, Select, TextArea, TextField } from '@heroui/react';
import type { DiagramEditor } from './useDiagramEditor';
import { CLASS_RELATIONS } from '../classDiagram';
import type { ClassRelation } from '../classDiagram';
import './flowchartEditor.css';

const relationNames: Record<ClassRelation, string> = {
  '<|--': 'Наследование', '--|>': 'Наследование', '*--': 'Композиция', '--*': 'Композиция',
  'o--': 'Агрегация', '--o': 'Агрегация', '-->': 'Ассоциация', '<--': 'Ассоциация',
  '--': 'Связь', '..': 'Пунктирная связь', '..>': 'Зависимость', '<..': 'Зависимость',
  '..|>': 'Реализация', '<|..': 'Реализация'
};

function SelectField({ label, value, placeholder, options, onChange }: {
  label: string;
  value: string;
  placeholder?: string;
  options: Array<{ id: string; label: string }>;
  onChange(value: string): void;
}): React.JSX.Element {
  return (
    <Select value={value || null} onChange={(key) => onChange(String(key ?? ''))} placeholder={placeholder}>
      <Label>{label}</Label>
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover><ListBox>
        {options.map((option) => (
          <ListBox.Item id={option.id} key={option.id} textValue={option.label}>
            {option.label}<ListBox.ItemIndicator />
          </ListBox.Item>
        ))}
      </ListBox></Select.Popover>
    </Select>
  );
}

function TextInput({ label, value, onChange }: {
  label: string;
  value: string;
  onChange(value: string): void;
}): React.JSX.Element {
  return <TextField fullWidth value={value} onChange={onChange}><Label>{label}</Label><Input aria-label={label} /></TextField>;
}

export function DiagramEditorPanel({ editor }: { editor: DiagramEditor }): React.JSX.Element | null {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [edgeLabel, setEdgeLabel] = useState('');
  const [relation, setRelation] = useState<ClassRelation>('-->');
  const model = editor.model;
  if (!model) return null;
  const isClass = model.kind === 'class';
  const node = editor.selection?.type === 'node' ? model.nodes.find(({ id }) => id === editor.selection?.id) : undefined;
  const edge = editor.selection?.type === 'edge' ? model.edges.find(({ id }) => id === editor.selection?.id) : undefined;
  const classNode = node?.members !== undefined ? { id: node.id, members: node.members } : null;
  const classEdge = edge?.relation !== undefined ? { id: edge.id, relation: edge.relation } : null;
  const fromId = model.nodes.some(({ id }) => id === from) ? from : model.nodes[0]?.id ?? '';
  const toId = model.nodes.some(({ id }) => id === to) ? to : model.nodes[1]?.id ?? fromId;
  const nodeOptions = model.nodes.map((item) => ({ id: item.id, label: `${item.label} (${item.id})` }));
  const edgeOptions = model.edges.map((item) => ({ id: item.id, label: `${item.from} → ${item.to}${item.label ? `: ${item.label}` : ''} (${item.id})` }));

  const addNode = (): void => {
    let index = 1;
    while (model.nodes.some(({ id }) => id === `node_${index}`)) index++;
    const id = `node_${index}`;
    editor.edit({ type: 'addNode', id, label: isClass ? 'Новый класс' : 'Новый узел' });
    editor.setSelection({ type: 'node', id });
  };
  const addEdge = (): void => editor.edit({ type: 'addEdge', from: fromId, to: toId, label: edgeLabel, relation });

  return (
    <aside className="flowchart-editor" aria-label={isClass ? 'Редактор классов и отношений' : 'Редактор узлов и связей'}>
      <h2>{isClass ? 'Классы и отношения' : 'Узлы и связи'}</h2>
      <p className="flowchart-editor__hint">
        {isClass ? 'Выберите класс или отношение на схеме либо в списке.' : 'Выберите узел или линию на схеме либо в списке.'}
        {' '}Mermaid рассчитывает расположение автоматически.
      </p>
      <fieldset disabled={editor.saving}>
        <legend>{isClass ? 'Классы' : 'Узлы'}</legend>
        <SelectField label={isClass ? 'Выбранный класс' : 'Выбранный узел'} value={node?.id ?? ''}
          placeholder={isClass ? 'Выберите класс' : 'Выберите узел'} options={nodeOptions}
          onChange={(id) => editor.setSelection(id ? { type: 'node', id } : null)} />
        {node && <>
          <TextInput label={isClass ? 'Подпись класса' : 'Подпись узла'} value={node.label}
            onChange={(label) => editor.edit({ type: 'renameNode', id: node.id, label })} />
          {classNode && <>
            <TextField fullWidth value={editor.memberDrafts[classNode.id]?.text ?? classNode.members.join('\n')}
              onChange={(value) => editor.edit({ type: 'updateMembers', id: classNode.id, members: value.split('\n') })}>
              <Label>Поля и методы</Label><TextArea id="class-members" rows={8} spellCheck={false} />
            </TextField>
            <span className="flowchart-editor__hint">Каждое поле или метод — на отдельной строке.</span>
          </>}
          <Button variant="danger-soft" onPress={() => editor.edit({ type: 'removeNode', id: node.id })}>
            {isClass ? 'Удалить класс и его отношения' : 'Удалить узел и его связи'}
          </Button>
        </>}
        <Button variant="secondary" onPress={addNode}>{isClass ? 'Добавить класс' : 'Добавить узел'}</Button>
      </fieldset>
      <fieldset disabled={editor.saving}>
        <legend>{isClass ? 'Отношения' : 'Связи'}</legend>
        <SelectField label={isClass ? 'Выбранное отношение' : 'Выбранная связь'} value={edge?.id ?? ''}
          placeholder={isClass ? 'Выберите отношение' : 'Выберите связь'} options={edgeOptions}
          onChange={(id) => editor.setSelection(id ? { type: 'edge', id } : null)} />
        {edge && <>
          <TextInput label={isClass ? 'Подпись отношения' : 'Подпись связи'} value={edge.label}
            onChange={(label) => editor.edit({ type: 'updateEdgeLabel', id: edge.id, label })} />
          {classEdge && <SelectField label="Тип отношения" value={classEdge.relation}
            options={CLASS_RELATIONS.map((value) => ({ id: value, label: `${relationNames[value]} (${value})` }))}
            onChange={(value) => {
              const next = CLASS_RELATIONS.find((item) => item === value);
              if (next) editor.edit({ type: 'updateRelation', id: classEdge.id, relation: next });
            }} />}
          <Button variant="danger-soft" onPress={() => editor.edit({ type: 'removeEdge', id: edge.id })}>
            {isClass ? 'Удалить отношение' : 'Удалить связь'}
          </Button>
        </>}
      </fieldset>
      <form onSubmit={(event) => { event.preventDefault(); addEdge(); }}>
        <fieldset disabled={editor.saving || model.nodes.length === 0}>
          <legend>{isClass ? 'Новое отношение' : 'Новая связь'}</legend>
          <SelectField label={isClass ? 'От класса' : 'От узла'} value={fromId} options={nodeOptions} onChange={setFrom} />
          <SelectField label={isClass ? 'К классу' : 'К узлу'} value={toId} options={nodeOptions} onChange={setTo} />
          {isClass && <SelectField label="Тип нового отношения" value={relation}
            options={CLASS_RELATIONS.map((value) => ({ id: value, label: `${relationNames[value]} (${value})` }))}
            onChange={(value) => { if (CLASS_RELATIONS.includes(value as ClassRelation)) setRelation(value as ClassRelation); }} />}
          <TextInput label={isClass ? 'Подпись нового отношения' : 'Подпись новой связи'} value={edgeLabel} onChange={setEdgeLabel} />
          <Button variant="secondary" type="submit">{isClass ? 'Добавить отношение' : 'Добавить связь'}</Button>
        </fieldset>
      </form>
      {editor.error && <div className="flowchart-editor__error" role="alert">
        {editor.error}<details><summary>Исходник черновика</summary><TextArea aria-label="Исходник черновика" readOnly value={editor.source} /></details>
      </div>}
    </aside>
  );
}
