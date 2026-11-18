const maxEntries = 32;
const maxCodeUnits = 2 * 1024 * 1024;

interface Preview {
  readonly svg: string;
  readonly ids: readonly string[];
  readonly size: number;
}

// Кэш хранит только строки. Хосты рендера, DOM и состояния React остаются у виджетов.
const previews = new Map<string, Preview>();
let totalSize = 0;

export function getMermaidPreview(key: string, host: HTMLElement): string | undefined {
  const preview = previews.get(key);
  if (!preview) return;

  // Mermaid связывает ID с CSS, маркерами и ссылками. Не меняем готовый SVG.
  // Если его ID уже заняты, второй виджет запустит обычный рендер.
  for (const id of preview.ids) {
    const owner = host.ownerDocument.getElementById(id);
    if (owner && !host.contains(owner)) return;
  }
  previews.delete(key);
  previews.set(key, preview);
  return preview.svg;
}

export function rememberMermaidPreview(key: string, svg: string, host: HTMLElement): void {
  const root = host.firstElementChild;
  if (!(root instanceof SVGSVGElement) || !root.id) return;
  const ids = [root.id, ...Array.from(root.querySelectorAll('[id]'), element => element.id)];
  const size = key.length + svg.length + ids.reduce((sum, id) => sum + id.length, 0);
  if (size > maxCodeUnits) return;

  const previous = previews.get(key);
  if (previous) totalSize -= previous.size;
  previews.delete(key);
  previews.set(key, { svg, ids, size });
  totalSize += size;
  for (const [oldKey, old] of previews) {
    if (previews.size <= maxEntries && totalSize <= maxCodeUnits) break;
    previews.delete(oldKey);
    totalSize -= old.size;
  }
}
