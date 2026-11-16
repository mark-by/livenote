/**
 * Отображение Markdown-блока.
 * Сырой HTML в source не исполняется: rehype-raw сознательно не подключается.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownBlockViewProps {
  source: string;
}

export function MarkdownBlockView({ source }: MarkdownBlockViewProps): React.JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}
