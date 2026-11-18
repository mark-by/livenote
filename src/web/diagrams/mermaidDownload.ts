import type { Block } from '../../shared/types';
import { downloadBlockPng } from '../api';
import { getThemeOverride } from '../mermaidInit';
import { downloadDiagramSvg, downloadTextFile } from '../svgDownload';
import { notifyDiagramDownload } from './diagramDownload';

export function downloadMermaid(
  format: 'svg' | 'png' | 'mmd',
  filename: string,
  block: Pick<Block, 'pageId' | 'id'>,
  content: string
): Promise<void> {
  return notifyDiagramDownload(filename, () => {
    if (format === 'png') {
      const theme = getThemeOverride() ?? undefined;
      return downloadBlockPng(block.pageId, block.id, filename, theme);
    } else if (format === 'svg') {
      return downloadDiagramSvg(content, filename);
    } else {
      downloadTextFile(content, filename, 'text/plain');
    }
  });
}
