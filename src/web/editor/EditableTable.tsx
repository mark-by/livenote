import { Children, isValidElement, memo, useCallback, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Dropdown, Input, Label, Table, TextArea } from '@heroui/react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChangeSpec } from '@codemirror/state';
import { changeTable, editTableCell } from './tableSource';
import type { TableAction, TableCellAddress, TableSource } from './tableSource';

function headerChildren(children: ReactNode): ReactNode {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return Children.toArray(child.props.children);
  });
}

const markdownComponents: Components = {
  table: ({ children }) => <Table><Table.ScrollContainer>
    <Table.Content aria-label="Таблица Markdown">{children}</Table.Content>
  </Table.ScrollContainer></Table>,
  thead: ({ children }) => <Table.Header>{headerChildren(children)}</Table.Header>,
  tbody: ({ children }) => <Table.Body>{children}</Table.Body>,
  tr: ({ children }) => <Table.Row>{children}</Table.Row>,
  th: ({ children, align, node }) => <Table.Column
    isRowHeader={node?.position?.start.offset === 0}
    style={{ textAlign: align === 'char' ? undefined : align ?? undefined }}>{children}</Table.Column>,
  td: ({ children, align }) => <Table.Cell
    style={{ textAlign: align === 'char' ? undefined : align ?? undefined }}>{children}</Table.Cell>,
  a: ({ href, children }) => <span role="link" className="lp-link" data-link={href || undefined}>{children}</span>
};

const TablePreview = memo(function TablePreview({ source }: { readonly source: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{source}</ReactMarkdown>;
});

function findCell(target: EventTarget | null, container: HTMLElement) {
  if (!(target instanceof Element)) return null;
  const cell = target.closest('td, th');
  const row = cell?.parentElement;
  if (!(cell instanceof HTMLTableCellElement) || !(row instanceof HTMLTableRowElement) || !container.contains(cell)) return null;
  return { cell, row: row.rowIndex, column: cell.cellIndex };
}

interface CellTarget extends TableCellAddress {
  readonly cell: HTMLTableCellElement;
  readonly table: TableSource;
}

interface TableMenu extends CellTarget {
  readonly x: number;
  readonly y: number;
}

type CellField = HTMLInputElement | HTMLTextAreaElement;

interface EditableTableProps {
  readonly source: string;
  readonly table: TableSource | null;
  readonly readOnly: boolean;
  readonly onChange: (table: TableSource, changes: ChangeSpec) => void;
  readonly onLink: (href: string) => void;
  readonly onHistory: (redo: boolean) => void;
}

export function EditableTable({ source, table, readOnly, onChange, onLink, onHistory }: EditableTableProps) {
  const preview = useRef<HTMLDivElement>(null);
  const input = useRef<CellField>(null);
  const menuOpen = useRef(false);
  const editing = useRef<CellTarget | null>(null);
  const [activeCell, setActiveCell] = useState<CellTarget | null>(null);
  const [menu, setMenu] = useState<TableMenu | null>(null);
  const editable = table !== null && !readOnly;
  const activeEdit = editable && activeCell?.table === table ? activeCell : null;
  const activeMenu = editable && menu?.table === table ? menu : null;
  const focusField = useCallback((element: CellField | null) => {
    input.current = element;
    element?.focus({ preventScroll: true });
  }, []);

  function focusCell({ row, column }: TableCellAddress) {
    requestAnimationFrame(() => {
      const grid = preview.current?.querySelector('table');
      const targetRow = grid?.rows[Math.min(row, grid.rows.length - 1)];
      targetRow?.cells[Math.min(column, targetRow.cells.length - 1)]?.focus({ preventScroll: true });
    });
  }

  function finishEdit(value: string | null, restoreFocus: boolean) {
    const target = editing.current;
    if (!target) return;
    editing.current = null;
    setActiveCell(null);
    if (value !== null) onChange(target.table, editTableCell(target.table, { ...target, value }));
    if (restoreFocus) focusCell(target);
  }

  function showMenu(target: CellTarget, x: number, y: number) {
    menuOpen.current = true;
    if (!activeEdit) target.cell.focus({ preventScroll: true });
    setMenu({ ...target, x, y });
  }

  function openEditor(target: CellTarget) {
    if (editing.current?.cell === target.cell) return;
    editing.current = target;
    setActiveCell(target);
  }

  function menuAction(action: TableAction) {
    if (!activeMenu) return;
    const draft = activeEdit && input.current ? { ...activeEdit, value: input.current.value } : undefined;
    menuOpen.current = false;
    if (draft) finishEdit(null, false);
    const changes = changeTable(activeMenu.table, activeMenu, action, draft);
    onChange(activeMenu.table, changes);
    setMenu(null);
    focusCell(activeMenu);
  }

  const fieldProps = activeEdit && {
    className: 'lp-table-input',
    ref: focusField,
    defaultValue: table?.rows[activeEdit.row]?.cells[activeEdit.column] ?? '',
    onBlur: (event: FocusEvent<CellField>) => {
      if (!menuOpen.current) finishEdit(event.currentTarget.value, false);
    },
    onKeyDown: (event: KeyboardEvent<CellField>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
      event.preventDefault();
      finishEdit(event.key === 'Enter' ? event.currentTarget.value : null, true);
    }
  };

  return <>
    <div ref={preview} data-table-editable={editable || undefined}
      onClick={event => {
        if (event.target instanceof Element) {
          const link = event.target.closest<HTMLElement>('[data-link]');
          if ((event.metaKey || event.ctrlKey) && link?.dataset.link) {
            event.preventDefault();
            onLink(link.dataset.link);
            return;
          }
          if (event.target === input.current) return;
        }
        const target = findCell(event.target, event.currentTarget);
        if (editable && target) openEditor({ ...target, table });
      }}
      onContextMenu={event => {
        const target = findCell(event.target, event.currentTarget);
        if (!editable || !target) return;
        event.preventDefault();
        event.stopPropagation();
        showMenu({ ...target, table }, event.clientX, event.clientY);
      }}
      onKeyDownCapture={event => {
        if (!editable) return;
        const target = findCell(event.target, event.currentTarget);
        if (!target) return;
        const openMenu = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
        if (!openMenu && event.target === input.current) return;
        const edit = event.key === 'Enter';
        const history = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z';
        if (!openMenu && !edit && !history) return;
        event.preventDefault();
        event.stopPropagation();
        if (openMenu) {
          const { left, bottom } = target.cell.getBoundingClientRect();
          showMenu({ ...target, table }, left, bottom);
        } else if (history) {
          onHistory(event.shiftKey);
          focusCell(target);
        } else openEditor({ ...target, table });
      }}>
      <TablePreview source={source} />
      {activeEdit && fieldProps && createPortal(activeEdit.row === 0
        ? <Input {...fieldProps} aria-label="Название колонки" />
        : <TextArea {...fieldProps} aria-label="Содержимое ячейки" rows={1} wrap="soft" />, activeEdit.cell)}
    </div>
    {(activeMenu || menu) && <Dropdown isOpen={activeMenu !== null} onOpenChange={open => {
      if (open) return;
      menuOpen.current = false;
      setMenu(null);
      if (activeEdit && editing.current === activeEdit) {
        requestAnimationFrame(() => {
          if (!menuOpen.current && editing.current === activeEdit) input.current?.focus({ preventScroll: true });
        });
      } else if (activeMenu) focusCell(activeMenu);
    }}>
      <Dropdown.Trigger aria-label="Действия с таблицей"
        data-menu-open={activeMenu ? '' : undefined}
        className="lp-table-menu-anchor" style={activeMenu ? { left: activeMenu.x, top: activeMenu.y } : undefined} />
      <Dropdown.Popover>
        <Dropdown.Menu aria-label="Действия с таблицей">
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item textValue="Добавить колонку"><Label>Добавить колонку</Label><Dropdown.SubmenuIndicator /></Dropdown.Item>
            <Dropdown.Popover><Dropdown.Menu aria-label="Добавление колонки">
              <Dropdown.Item onAction={() => menuAction('column-before')}>Перед</Dropdown.Item>
              <Dropdown.Item onAction={() => menuAction('column-after')}>После</Dropdown.Item>
            </Dropdown.Menu></Dropdown.Popover>
          </Dropdown.SubmenuTrigger>
          <Dropdown.Item variant="danger" isDisabled={table?.width === 1}
            onAction={() => menuAction('column-delete')}>Удалить колонку</Dropdown.Item>
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item textValue="Добавить строку"><Label>Добавить строку</Label><Dropdown.SubmenuIndicator /></Dropdown.Item>
            <Dropdown.Popover><Dropdown.Menu aria-label="Добавление строки">
              <Dropdown.Item isDisabled={activeMenu?.row === 0} onAction={() => menuAction('row-before')}>Перед</Dropdown.Item>
              <Dropdown.Item onAction={() => menuAction('row-after')}>После</Dropdown.Item>
            </Dropdown.Menu></Dropdown.Popover>
          </Dropdown.SubmenuTrigger>
          <Dropdown.Item variant="danger" isDisabled={activeMenu?.row === 0}
            onAction={() => menuAction('row-delete')}>Удалить строку</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>}
  </>;
}
