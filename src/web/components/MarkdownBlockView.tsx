/**
 * Непрерывный Markdown-просмотр. Внутренние ссылки превращаются в навигацию
 * по существующим страницам, сырой HTML по-прежнему не исполняется.
 */
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { VaultLink } from '../../shared/types';

interface MarkdownBlockViewProps {
  source: string;
  links?: VaultLink[];
  onOpenPage?(pageId: string, fragment?: string): void;
}

function escapeLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
}

/** Wiki-ссылки вне fenced/inline code становятся обычными Markdown-ссылками. */
export function prepareWikiLinks(source: string): string {
  const excluded: Array<[number, number]> = [];
  type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] };
  const walk = (node: Node): void => {
    if (['code', 'inlineCode', 'image', 'imageReference', 'html', 'link', 'linkReference', 'definition'].includes(node.type) && node.position) {
      excluded.push([node.position.start.offset!, node.position.end.offset!]);
      return;
    }
    node.children?.forEach(walk);
  };
  walk(fromMarkdown(source) as Node);
  return source.replace(/\[\[([^\]\r\n]+)\]\]/g, (match, body: string, offset: number) => {
    let backslashes = 0;
    while (source[offset - backslashes - 1] === '\\') backslashes++;
    if (backslashes % 2 || excluded.some(([start, end]) => offset >= start && offset < end)) return match;
    const separator = body.indexOf('|');
    const target = separator >= 0 ? body.slice(0, separator) : body;
    const label = separator >= 0 ? body.slice(separator + 1) : target.split('#')[0];
    return `[${escapeLabel(label || target)}](livenote:${encodeURIComponent(target)})`;
  });
}

export function MarkdownBlockView({ source, links = [], onOpenPage }: MarkdownBlockViewProps): React.JSX.Element {
  return (
    <div className="markdown-body markdown-body--native-tables">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key, node) => key === 'href' && node.tagName === 'a' && /^livenote:(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/.test(url)
          ? url : defaultUrlTransform(url)}
        components={{
          a: ({ href = '', children, ...props }) => {
            const wiki = href.startsWith('livenote:');
            let target: string;
            try { target = wiki ? decodeURIComponent(href.slice('livenote:'.length)) : decodeURIComponent(href); }
            catch { return <span className="vault-unresolved-link" title="Ссылка не разрешена">{children}</span>; }
            const hash = target.indexOf('#');
            const destination = hash < 0 ? target : target.slice(0, hash);
            const fragment = hash < 0 ? null : target.slice(hash + 1);
            const link = links.find((item) => item.kind === (wiki ? 'wiki' : 'markdown') && (
              item.target === destination || (() => { try { return decodeURIComponent(item.target) === destination; } catch { return false; } })()
            ) && item.fragment === fragment);
            if (link?.targetPageId && onOpenPage) {
              return (
                <a
                  {...props}
                  href={`#page-${encodeURIComponent(link.targetPageId)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenPage(link.targetPageId!, link.fragment ?? undefined);
                  }}
                >{children}</a>
              );
            }
            if (wiki) return <span className="vault-unresolved-link" title="Ссылка не разрешена">{children}</span>;
            return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
          }
        }}
      >{prepareWikiLinks(source)}</ReactMarkdown>
    </div>
  );
}
