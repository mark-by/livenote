import { Children, cloneElement, isValidElement } from 'react';
import type { ReactNode } from 'react';
import { Table } from '@heroui/react';
import type { Components, ExtraProps } from 'react-markdown';
import type { ComponentProps } from 'react';

type HeaderProps = ComponentProps<'th'> & ExtraProps & { readonly rowHeader?: boolean };

function headerChildren(children: ReactNode): ReactNode {
  return Children.toArray(children).flatMap(row => {
    if (!isValidElement<{ children?: ReactNode }>(row)) return [];
    return Children.toArray(row.props.children).filter(isValidElement<HeaderProps>)
      .map((column, index) => cloneElement(column, { rowHeader: index === 0 }));
  });
}

function Column({ children, align, rowHeader }: HeaderProps) {
  return <Table.Column isRowHeader={rowHeader}
    style={{ textAlign: align === 'char' ? undefined : align ?? undefined }}>{children}</Table.Column>;
}

export const markdownPreviewTable: Components = {
  table: ({ children }) => <Table><Table.ScrollContainer>
    <Table.Content aria-label="Таблица Markdown">{children}</Table.Content>
  </Table.ScrollContainer></Table>,
  thead: ({ children }) => <Table.Header>{headerChildren(children)}</Table.Header>,
  tbody: ({ children }) => <Table.Body>{children}</Table.Body>,
  tr: ({ children }) => <Table.Row>{children}</Table.Row>,
  th: Column,
  td: ({ children, align }) => <Table.Cell
    style={{ textAlign: align === 'char' ? undefined : align ?? undefined }}>{children}</Table.Cell>,
};
