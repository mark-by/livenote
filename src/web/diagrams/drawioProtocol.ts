export const DRAWIO_FRAME_URL =
  '/drawio/index.html?embed=1&proto=json&offline=1&noSaveBtn=1&noExitBtn=1&saveAndExit=0&contrast=0&ui=simple&sidebar=0&format=0';
export const DRAWIO_MODAL_EVENT = 'livenote:drawio-modal';

export type ExportFormat = 'xml' | 'svg';
export type DrawioMessage = {
  readonly event?: string;
  readonly requestId?: string;
  readonly message?: { readonly requestId?: string };
  readonly xml?: string;
  readonly data?: string;
  readonly error?: string;
};

class DrawioFrameError extends Error {
  constructor(readonly reason: string) {
    super(`Локальный редактор draw.io: ${reason}`);
    this.name = 'DrawioFrameError';
  }
}

export function messageError(reason: string): Error {
  return new DrawioFrameError(reason);
}

/** Ответ существующего embed-протокола; UTF-8 сохраняется и для base64 SVG. */
export function decodeExport(message: DrawioMessage, format: ExportFormat): string {
  if (format === 'xml' && typeof message.xml === 'string') return message.xml;
  const data = message.data;
  if (typeof data !== 'string' || data.length === 0) throw messageError(`пустой ответ экспорта ${format.toUpperCase()}`);
  if (!data.startsWith('data:')) return data;
  const comma = data.indexOf(',');
  if (comma < 0) throw messageError('некорректный data URL');
  const metadata = data.slice(0, comma);
  const payload = data.slice(comma + 1);
  if (metadata.endsWith(';base64')) {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(payload);
}
