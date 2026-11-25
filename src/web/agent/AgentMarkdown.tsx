import { Children, isValidElement } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '../components/CopyButton';

function textContent(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(value)) return textContent(value.props.children);
  return '';
}

function AgentCodeBlock({ children }: { readonly children?: ReactNode }): React.JSX.Element {
  const child = Children.toArray(children)[0];
  const props = isValidElement<{ className?: string; children?: ReactNode }>(child) ? child.props : {};
  const code = textContent(props.children).replace(/\n$/, '');
  const language = /language-(\w+)/.exec(props.className ?? '')?.[1] ?? 'код';

  return <div className="agent-code">
    <div className="agent-code__header">
      <span>{language}</span>
      <CopyButton text={code} title="Копировать код" className="agent-code__copy" />
    </div>
    <pre className="agent-code__body">{children}</pre>
  </div>;
}

/** Рендерит ответ без встраивания HTML и с безопасным преобразованием URL. */
export function AgentMarkdown({ children }: { readonly children: string }): React.JSX.Element {
  return <div className="agent-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={defaultUrlTransform} components={{
      pre: ({ children: content }) => <AgentCodeBlock>{content}</AgentCodeBlock>,
      a: ({ href, title, children: content }) => href
        ? <a href={href} title={title} target="_blank" rel="noreferrer">{content}</a>
        : <>{content}</>
    }}>{children}</ReactMarkdown>
  </div>;
}
