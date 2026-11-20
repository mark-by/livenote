import type { ChangeSpec, Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

interface TableLine {
  readonly from: number;
  readonly to: number;
  readonly prefix: string;
  readonly cells: readonly string[];
}

export interface TableSource {
  readonly rows: readonly TableLine[];
  readonly delimiter: TableLine;
  readonly width: number;
}

export interface TableCellAddress {
  readonly row: number;
  readonly column: number;
}

interface TableCellDraft extends TableCellAddress {
  readonly value: string;
}

export type TableAction = 'column-before' | 'column-after' | 'column-delete' |
  'row-before' | 'row-after' | 'row-delete';

const trimCell = (value: string): string => value.replace(/^[ \t]+|[ \t]+$/g, '');

function splitCells(source: string): string[] {
  const cells = [];
  let start = source.startsWith('|') ? 1 : 0;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '\\' && (next === '\\' || next === '|')) index++;
    else if (char === '|') {
      cells.push(trimCell(source.slice(start, index)));
      start = index + 1;
    }
  }
  const tail = trimCell(source.slice(start));
  if (tail || !cells.length || source[start - 1] !== '|') cells.push(tail);
  return cells;
}

export function readTable(doc: Text, node: SyntaxNode): TableSource | null {
  const rows: TableLine[] = [];
  let delimiter: TableLine | undefined;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'TableHeader' && child.name !== 'TableRow' && child.name !== 'TableDelimiter') continue;
    const { from, to } = child;
    const source = doc.sliceString(from, to);
    const prefix = doc.sliceString(doc.lineAt(from).from, from);
    const line = { from, to, prefix, cells: splitCells(source) };
    if (child.name === 'TableDelimiter') delimiter = line;
    else rows.push(line);
  }
  return delimiter && rows[0]?.cells.length === delimiter.cells.length
    ? { rows, delimiter, width: delimiter.cells.length } : null;
}

const formatRow = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

function rowWithWidth(row: TableLine, width: number): string[] {
  return Array.from({ length: Math.max(width, row.cells.length) }, (_, index) => row.cells[index] ?? '');
}

function applyDraft(cells: string[], { column, value }: TableCellDraft) {
  cells[column] = trimCell(value.replace(/\r\n?|\n/g, ' '))
    .replace(/\\[\\|]|[|]/g, token => token === '|' ? '\\|' : token);
}

export function editTableCell(table: TableSource, draft: TableCellDraft): ChangeSpec {
  const { row, column, value } = draft;
  const line = table.rows[row];
  if (!line || column >= table.width || value === (line.cells[column] ?? '')) return [];
  const cells = rowWithWidth(line, table.width);
  applyDraft(cells, draft);
  if (cells[column] === (line.cells[column] ?? '')) return [];
  return { from: line.from, to: line.to, insert: formatRow(cells) };
}

export function changeTable(
  table: TableSource, { row, column }: TableCellAddress, action: TableAction, draft?: TableCellDraft
): ChangeSpec {
  const line = table.rows[row];
  if (!line || column >= table.width) return [];
  switch (action) {
    case 'column-before':
    case 'column-after':
    case 'column-delete': {
      if (action === 'column-delete' && table.width === 1) return [];
      const [header, ...body] = table.rows;
      if (!header) return [];
      return [header, table.delimiter, ...body].map(current => {
        const cells = rowWithWidth(current, table.width);
        if (draft && current === table.rows[draft.row]) applyDraft(cells, draft);
        if (action === 'column-delete') cells.splice(column, 1);
        else cells.splice(column + (action === 'column-after' ? 1 : 0), 0, current === table.delimiter ? '---' : '');
        return { from: current.from, to: current.to, insert: formatRow(cells) };
      });
    }
    case 'row-before':
    case 'row-after': {
      const empty = formatRow(Array<string>(table.width).fill(''));
      const after = row === 0 ? table.delimiter : line;
      const insert = row !== 0 && action === 'row-before'
        ? { from: line.from - line.prefix.length, insert: `${line.prefix}${empty}\n` }
        : { from: after.to, insert: `\n${after.prefix}${empty}` };
      return draft ? [editTableCell(table, draft), insert] : insert;
    }
    case 'row-delete': {
      if (row === 0) return [];
      const remove = { from: line.from - line.prefix.length - 1, to: line.to };
      return draft && draft.row !== row ? [editTableCell(table, draft), remove] : remove;
    }
  }
}
