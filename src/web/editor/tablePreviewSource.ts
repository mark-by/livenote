export interface TablePreviewSource {
  readonly header: string;
  readonly delimiter: string;
  readonly rows: readonly string[];
  readonly width: number;
  readonly definitions: string;
}

const maxBodyRows = 32;
const maxBodyCells = 320;

export function tablePageSize(width: number): number {
  return Math.max(1, Math.min(maxBodyRows, Math.floor(maxBodyCells / width)));
}

export function tablePageMarkdown(source: TablePreviewSource, offset: number, pageSize: number): string {
  const rows = source.rows.slice(offset, offset + pageSize);
  const markdown = [source.header, source.delimiter, ...rows].join('\n');
  return source.definitions ? `${markdown}\n\n${source.definitions}` : markdown;
}
