import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import {
  Alert, Button, Checkbox, Chip, CloseButton, ComboBox, Disclosure,
  Dropdown, Input, Label, Link, ListBox, NumberField, Select, TextField,
} from '@heroui/react';
import { Ellipsis, Pencil, Plus, TrashBin } from '@gravity-ui/icons';
import type { EditableValue, Properties, Property, PropertyEdit } from './frontmatterProperties';

type ValueType = 'text' | 'number' | 'flag' | 'tags';
const types = { text: 'Текст', number: 'Число', flag: 'Флажок', tags: 'Теги' } as const;
const rowLayout = 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @lg:grid-cols-[11rem_minmax(0,1fr)_auto]';

function nameError(name: string, used: readonly string[]): string {
  return used.includes(name.trim()) ? 'Свойство с таким именем уже есть' : '';
}

function AddProperty({ used, onAdd, onCancel }: {
  readonly used: readonly string[];
  readonly onAdd: (edit: PropertyEdit) => void;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ValueType>('text');
  const [text, setText] = useState('');
  const [flag, setFlag] = useState(false);
  const effectiveType = name.trim() === 'tags' ? 'tags' : type;
  const number = Number(text);
  const error = nameError(name, used);
  const valid = Boolean(name.trim() && !error &&
    (effectiveType === 'flag' || (text.trim() && (effectiveType !== 'number' || Number.isFinite(number)))));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const value = effectiveType === 'flag' ? flag : effectiveType === 'number' ? number :
      effectiveType === 'tags' ? [text.trim()] : text;
    onAdd({ kind: 'add', name: name.trim(), value });
  }

  return <form aria-label="Новое свойство" onSubmit={submit} onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented) onCancel();
  }} className="flex min-w-0 flex-col gap-3 py-1">
    <div className="grid min-w-0 gap-3 @lg:grid-cols-[minmax(0,16rem)_minmax(0,11rem)_minmax(0,1fr)]">
      <ComboBox allowsCustomValue inputValue={name} onInputChange={setName} isInvalid={Boolean(error)}>
        <Label>Имя свойства</Label>
        <ComboBox.InputGroup><Input autoFocus placeholder="Например, owner" /><ComboBox.Trigger /></ComboBox.InputGroup>
        <ComboBox.Popover><ListBox>
          {used.includes('tags') ? null : <ListBox.Item id="tags" textValue="tags">tags<ListBox.ItemIndicator /></ListBox.Item>}
        </ListBox></ComboBox.Popover>
        {error && <span role="alert" className="text-sm text-danger">{error}</span>}
      </ComboBox>
      <Select value={effectiveType} isDisabled={effectiveType === 'tags'} onChange={value => {
        if (value === 'text' || value === 'number' || value === 'flag') setType(value);
      }}>
        <Label>Тип</Label>
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover><ListBox>
          <ListBox.Item id="text">{types.text}</ListBox.Item>
          <ListBox.Item id="number">{types.number}</ListBox.Item>
          <ListBox.Item id="flag">{types.flag}</ListBox.Item>
          {effectiveType === 'tags' && <ListBox.Item id="tags">{types.tags}</ListBox.Item>}
        </ListBox></Select.Popover>
      </Select>
      {effectiveType === 'flag' ?
        <Checkbox className="@lg:pt-6" isSelected={flag} onChange={setFlag}>
          <Checkbox.Content className="min-h-9"><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>Значение</Checkbox.Content>
        </Checkbox> :
        <TextField value={text} onChange={setText}>
          <Label>Значение</Label><Input inputMode={effectiveType === 'number' ? 'decimal' : 'text'} placeholder={effectiveType === 'tags' ? 'Первый тег' : undefined} />
        </TextField>}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" isDisabled={!valid}>Добавить</Button>
      <Button type="button" size="sm" variant="ghost" onPress={onCancel}>Отмена</Button>
    </div>
  </form>;
}

function Tags({ tags, onChange, readOnly }: { readonly tags: readonly string[]; readonly onChange: (tags: readonly string[]) => void; readonly readOnly: boolean }) {
  const [text, setText] = useState<string | null>(null);
  return <div className="flex flex-wrap items-center gap-2">
    {[...new Set(tags)].map(tag => <Chip key={tag} variant="secondary">
      <Chip.Label>{tag}</Chip.Label>
      {!readOnly && <CloseButton aria-label={`Удалить тег ${tag}`} onPress={() => onChange(tags.filter(value => value !== tag))} />}
    </Chip>)}
    {!readOnly && (text === null ?
      <Button size="sm" variant="ghost" isIconOnly aria-label="Добавить тег" onPress={() => setText('')}><Plus /></Button> :
      <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={event => {
        event.preventDefault();
        const tag = text.trim().replace(/^#/, '');
        if (tag && !tags.includes(tag)) onChange([...tags, tag]);
        setText(null);
      }}>
        <Input autoFocus aria-label="Новый тег" className="w-36 max-w-full" value={text} onChange={event => setText(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setText(null); } }} />
        <Button type="submit" variant="secondary" size="sm">Добавить тег</Button>
      </form>)}
  </div>;
}

function PropertyValue({ property, onChange, readOnly }: { readonly property: Property; readonly onChange: (value: EditableValue) => void; readonly readOnly: boolean }) {
  const { name, value } = property;
  const label = `Значение ${name}`;
  switch (typeof value) {
    case 'boolean':
      return <Checkbox aria-label={label} isReadOnly={readOnly} isSelected={value} onChange={onChange}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control></Checkbox.Content></Checkbox>;
    case 'number':
      return <NumberField aria-label={label} isReadOnly={readOnly} className="w-52 max-w-full" formatOptions={{ useGrouping: false }} value={value} onChange={next => { if (Number.isFinite(next)) onChange(next); }}>
        <NumberField.Group><NumberField.DecrementButton aria-label={`Уменьшить ${name}`} /><NumberField.Input className="min-w-0 flex-1" /><NumberField.IncrementButton aria-label={`Увеличить ${name}`} /></NumberField.Group>
      </NumberField>;
    case 'string':
      return <div className="flex max-w-md min-w-0 items-center gap-2">
        <Input aria-label={label} readOnly={readOnly} key={value} defaultValue={value}
          className="min-w-0 flex-1"
          onBlur={event => onChange(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
        {/^(https?):\/\//.test(value) && <Link href={value} target="_blank" rel="noreferrer" className="shrink-0 text-sm">Открыть ↗</Link>}
      </div>;
    case 'object':
      return 'yaml' in value ? <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all text-sm">{value.yaml}</code><Chip size="sm">Только чтение</Chip>
      </div> : <Tags tags={value} onChange={onChange} readOnly={readOnly} />;
  }
}

function PropertyRow({ property, rows, onEdit, locked }: {
  readonly property: Property;
  readonly rows: readonly Property[];
  readonly onEdit: (edit: PropertyEdit) => void;
  readonly locked: boolean;
}) {
  const [rename, setRename] = useState<string | null>(null);
  const name = property.name;
  const readOnly = locked || !property.editable;
  const canRename = !readOnly && name !== 'tags';
  const canRemove = !locked && property.removable;
  const renameError = rename?.trim() === 'tags' ? 'Имя tags зарезервировано' :
    nameError(rename ?? '', rows.filter(row => row !== property).map(row => row.name));
  const finishRename = () => {
    const next = rename?.trim();
    setRename(null);
    if (canRename && next && next !== name && !renameError) onEdit({ kind: 'rename', name, next });
  };
  return <div className={rowLayout}>
    <div className="col-start-1 row-start-1 min-w-0">
      {!canRename ? <span className="block break-all px-2 text-sm text-muted">{name}</span> :
        rename === null ? <Button variant="ghost" size="sm" fullWidth aria-label={`Переименовать ${name}`}
          className="h-auto min-h-8 min-w-0 max-w-full justify-start whitespace-normal break-all px-2 py-1 text-left text-muted"
          onPress={() => setRename(name)}>{name}</Button> :
          <div>
            <Input aria-label="Новое имя свойства" autoFocus fullWidth className="min-w-0 max-w-full"
              value={rename} onChange={event => setRename(event.target.value)} onBlur={finishRename}
              onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); setRename(null); }
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (rename.trim() && !renameError) finishRename();
                }
              }} />
            {renameError && <span role="alert" className="text-sm text-danger">{renameError}</span>}
          </div>}
    </div>
    <div className="col-span-2 col-start-1 row-start-2 min-w-0 @lg:col-span-1 @lg:col-start-2 @lg:row-start-1">
      <PropertyValue property={property} readOnly={readOnly} onChange={value => onEdit({ kind: 'set', name, value })} />
    </div>
    {canRemove && <Dropdown>
      <Button className="col-start-2 row-start-1 @lg:col-start-3" size="sm" variant="ghost" isIconOnly aria-label={`Действия: ${name}`}><Ellipsis /></Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={`Действия: ${name}`} onAction={key => {
          if (key === 'rename') setRename(name);
          if (key === 'delete') onEdit({ kind: 'remove', name });
        }}>
          {canRename && <Dropdown.Item id="rename" textValue="Переименовать"><Pencil /><Label>Переименовать</Label></Dropdown.Item>}
          <Dropdown.Item id="delete" variant="danger" textValue="Удалить свойство"><TrashBin /><Label className="text-danger-soft-foreground">Удалить свойство</Label></Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>}
  </div>;
}

export function DocumentProperties({ properties, locked, onEdit, onHistory, onSave }: {
  readonly properties: Properties;
  readonly locked: boolean;
  readonly onEdit: (edit: PropertyEdit) => void;
  readonly onHistory: (redo: boolean) => void;
  readonly onSave: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(true);
  function keyboard(event: KeyboardEvent) {
    if (locked || !(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (event.target instanceof HTMLInputElement) event.target.blur();
      onSave();
      return;
    }
    if (event.key.toLowerCase() !== 'z') return;
    if (event.target instanceof HTMLInputElement && !event.target.readOnly) return;
    event.preventDefault();
    onHistory(event.shiftKey);
  }
  if (properties.kind === 'invalid') {
    return <Alert status="warning" role="alert"><Alert.Content><Alert.Title>Не удалось разобрать YAML</Alert.Title><Alert.Description>Исправьте исходный текст, чтобы редактировать свойства.</Alert.Description></Alert.Content></Alert>;
  }
  const { rows } = properties;
  const canAdd = !locked && (properties.kind === 'missing' || (properties.kind === 'valid' && properties.canAdd));
  const addingProperty = canAdd && adding;
  const addButton = canAdd && <Button size="sm" variant="ghost" onPress={() => { setExpanded(true); setAdding(true); }}><Plus />Добавить свойство</Button>;
  return <div onKeyDown={keyboard} className="@container pb-4 min-w-0 whitespace-normal font-sans">
      {rows.length || addingProperty ? <Disclosure isExpanded={expanded} onExpandedChange={setExpanded}>
        <Disclosure.Heading><Button slot="trigger" variant="secondary">Свойства<Disclosure.Indicator /></Button></Disclosure.Heading>
        <Disclosure.Content><Disclosure.Body className="grid gap-2 px-0 pt-3">
          {rows.map(property => <PropertyRow key={property.name} property={property} rows={rows} locked={locked} onEdit={onEdit} />)}
          {(canAdd || addingProperty) && <div>{addingProperty ? <AddProperty used={rows.map(row => row.name)} onCancel={() => setAdding(false)} onAdd={edit => {
            onEdit(edit);
            setAdding(false);
          }} /> : addButton}</div>}
        </Disclosure.Body></Disclosure.Content>
      </Disclosure> : <div>{addButton}</div>}
  </div>;
}
