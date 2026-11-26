import { Accordion, Button, Separator } from '@heroui/react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { detailsBody, detailsRanges } from './detailsSource';
import { markdownPreviewTable } from './markdownPreviewTable';

interface MarkdownDetailsProps {
  readonly summary: string;
  readonly source: string;
  readonly open: boolean;
  readonly onLink?: (target: string) => void;
}

function Content({ source, onLink }: Pick<MarkdownDetailsProps, 'source' | 'onLink'>) {
  const components: Components = {
    ...markdownPreviewTable,
    hr: () => <Separator className="my-4" />,
    // Цель ссылки проверяет оболочка редактора, а не браузер.
    a: ({ href, children }) => href && onLink
      ? <Button variant="ghost" size="sm" className="h-auto min-w-0 p-0 text-accent underline"
          onPress={() => onLink(href)}>{children}</Button>
      : <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
  };
  const markdown = (from: number, to: number) => <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
    {source.slice(from, to)}
  </ReactMarkdown>;
  let from = 0;
  const blocks = detailsRanges(source).map(block => {
    const preceding = markdown(from, block.from);
    from = block.to;
    return <div key={block.from}>{preceding}<MarkdownDetails summary={block.summary}
      source={detailsBody(source.slice(block.bodyFrom, block.bodyTo), block.bodyIndent)}
      open={block.open} onLink={onLink} /></div>;
  });
  return <div className="markdown-body min-w-0 break-words">{blocks}{markdown(from, source.length)}</div>;
}

export function MarkdownDetails({ summary, source, open, onLink }: MarkdownDetailsProps) {
  const [expanded, setExpanded] = useState(open);
  return <Accordion variant="surface" hideSeparator className="min-w-0 rounded-2xl shadow-surface"
      expandedKeys={expanded ? ['details'] : []}
      onExpandedChange={keys => setExpanded(keys.has('details'))}>
      <Accordion.Item id="details">
        <Accordion.Heading render={props => <h3 {...props} role="presentation" />}>
          <Accordion.Trigger className="gap-2 text-left hover:bg-transparent">
            <span className="min-w-0 break-words">{summary}</span>
            <Accordion.Indicator />
          </Accordion.Trigger>
        </Accordion.Heading>
        <Accordion.Panel>
          <Accordion.Body><div inert={!expanded}><Content source={source} onLink={onLink} /></div></Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>;
}
