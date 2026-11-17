import { fromMarkdown } from 'mdast-util-from-markdown';
import { isMap, isNode, isScalar, parseDocument } from 'yaml';
import { z } from 'zod';
import { applyEdits } from './vaultDocument.js';
import { InvalidRequestError } from './errors.js';

const markerSchema = z.object({
  id: z.string(), type: z.enum(['markdown', 'mermaid', 'bpmn', 'drawio']),
  title: z.string().optional(), framingNewline: z.literal(true).optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional()
}).passthrough();
/** Только миграция понимает устаревшие служебные поля и framing newline. */
export function legacyDocument(original: string): { source: string; id?: string; title?: string; assets: Array<{ target: string; title?: string }> } {
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const fm = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(original);
  let id: string | undefined; let title: string | undefined;
  if (fm?.index === 0) {
    const text = fm[1] ?? ''; const offset = original.indexOf('\n') + 1;
    const yaml = parseDocument(text, { keepSourceTokens: true, schema: 'core', resolveKnownTags: false });
    if (yaml.errors.length || !isMap(yaml.contents)) throw new InvalidRequestError('Некорректный legacy YAML');
    const oldId: unknown = yaml.get('id'); const oldTitle: unknown = yaml.get('title');
    if (typeof oldId === 'string') id = oldId; if (typeof oldTitle === 'string') title = oldTitle;
    for (const pair of yaml.contents.items) {
      if (!isScalar(pair.key) || !['id', 'title', 'created', 'updated'].includes(String(pair.key.value))) continue;
      if (!isNode(pair.value) || !pair.key.range || !pair.value.range) throw new InvalidRequestError('Не удалось безопасно удалить legacy metadata');
      const start = text.lastIndexOf('\n', pair.key.range[0] - 1) + 1;
      const lineEnd = text.indexOf('\n', pair.value.range[1]);
      const end = lineEnd < 0 ? text.length : lineEnd + 1;
      const trailing = text.slice(pair.value.range[1], end);
      const comment = /#[^\r\n]*/.exec(trailing)?.[0];
      edits.push({ start: offset + start, end: offset + end, value: comment ? comment + (original.includes('\r\n') ? '\r\n' : '\n') : '' });
    }
    if (yaml.contents.items.every(pair => isScalar(pair.key) && ['id', 'title', 'created', 'updated'].includes(String(pair.key.value))) && !/^ *#/m.test(text)) {
      edits.splice(0); edits.push({ start: 0, end: fm[0].length, value: '' });
    }
  }
  const tree = fromMarkdown(original);
  const htmlRanges: Array<{ start: number; end: number }> = [];
  const walk = (node: typeof tree | (typeof tree.children)[number]): void => {
    if (node.type === 'html') {
      const start = node.position?.start.offset; const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) htmlRanges.push({ start, end });
    }
    if ('children' in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  const markers = [...original.matchAll(/^<!-- livenote:block\b[^\r\n]*(?:\r?\n|$)/gm)].filter(match => htmlRanges.some(range => match.index >= range.start && match.index < range.end));
  const assets: Array<{ target: string; title?: string }> = [];
  for (const [index, match] of markers.entries()) {
    const json = /^<!-- livenote:block (.+) -->[ \t]*(?:\r?\n|$)$/.exec(match[0]);
    let value: unknown;
    try { value = JSON.parse(json?.[1] ?? ''); } catch { throw new InvalidRequestError('Неизвестный legacy marker'); }
    const result = markerSchema.safeParse(value);
    if (!result.success) throw new InvalidRequestError('Неизвестные поля legacy marker', result.error.issues);
    const metadata = result.data; const start = match.index + match[0].length; const end = markers[index + 1]?.index ?? original.length;
    const raw = original.slice(start, end);
    edits.push({ start: match.index, end: start, value: metadata.type === 'mermaid' && metadata.title ? '## ' + metadata.title + (original.includes('\r\n') ? '\r\n' : '\n') : '' });
    if (metadata.framingNewline) {
      if (metadata.type !== 'markdown' || !raw.endsWith('\n')) throw new InvalidRequestError('Некорректный legacy framingNewline');
      const length = raw.endsWith('\r\n') ? 2 : 1;
      // Native Markdown соседствует через обычный separator; provenance хранит исходные block bytes.
      if (index === markers.length - 1) edits.push({ start: end - length, end, value: '' });
    }
    if (metadata.type === 'bpmn' || metadata.type === 'drawio') {
      const parsed = fromMarkdown(raw); const paragraph = parsed.children[0]; const image = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
      if (image?.type !== 'image') throw new InvalidRequestError('Неизвестное legacy XML встраивание');
      assets.push({ target: image.url, ...(metadata.title ? { title: metadata.title } : {}) });
    }
  }
  return { source: applyEdits(original, edits), ...(id ? { id } : {}), ...(title ? { title } : {}), assets };
}
