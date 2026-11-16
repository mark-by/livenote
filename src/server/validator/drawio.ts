import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import type { Element } from '@xmldom/xmldom';
import type { Browser, Page } from 'playwright';
import type { DiagramValidation, DiagramValidator } from '../../shared/types.js';

const MAX_XML_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const unavailable: DiagramValidation = { syntax: 'not_checked', renderer: 'unavailable' };

function xml(source: string): Element {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('Объявления DTD и сущностей запрещены');
  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (_level, message) => errors.push(message)
  }).parseFromString(source, 'application/xml');
  if (errors.length || !doc.documentElement) throw new Error(errors[0] ?? 'Пустой XML');
  return doc.documentElement;
}

function check(source: string): DiagramValidation {
  try {
    let size = Buffer.byteLength(source);
    if (size > MAX_XML_BYTES) throw new Error('Превышен размер XML');
    const root = xml(source);
    if (root.tagName !== 'mxfile' && root.tagName !== 'mxGraphModel') {
      throw new Error('Ожидается mxfile или mxGraphModel');
    }
    if (root.tagName === 'mxfile') {
      for (let node = root.firstChild; node; node = node.nextSibling) {
        if (node.nodeType !== 1) continue;
        const diagram = node as Element;
        if (diagram.tagName !== 'diagram') throw new Error('Неизвестный элемент mxfile');
        const children = Array.from({ length: diagram.childNodes.length }, (_, i) => diagram.childNodes.item(i))
          .filter((child) => child?.nodeType === 1);
        if (children.length) {
          if (children.length !== 1 || (children[0] as Element).tagName !== 'mxGraphModel') {
            throw new Error('Ожидается mxGraphModel внутри diagram');
          }
          continue;
        }
        const encoded = (diagram.textContent ?? '').trim().replace(/\s/g, '');
        if (!encoded) continue;
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          throw new Error('Некорректный base64 страницы');
        }
        const bytes = inflateRawSync(Buffer.from(encoded, 'base64'), { maxOutputLength: MAX_XML_BYTES - size });
        size += bytes.length;
        const decoded = decodeURIComponent(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        size += Buffer.byteLength(decoded);
        if (size > MAX_XML_BYTES) throw new Error('Превышен размер страниц');
        if (xml(decoded).tagName !== 'mxGraphModel') throw new Error('Ожидается mxGraphModel страницы');
      }
    }
    return { syntax: 'ok', renderer: 'playwright', diagramType: 'drawio' };
  } catch (error) {
    return { syntax: 'error', renderer: 'playwright', error: { message: error instanceof Error ? error.message : String(error) } };
  }
}

class DrawioValidator implements DiagramValidator {
  readonly kind = 'playwright' as const;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly baseUrl: string) {}

  async parse(source: string): Promise<DiagramValidation> {
    return check(source);
  }

  render(source: string, options?: { includeImage?: boolean }): ReturnType<DiagramValidator['render']> {
    const run = this.queue.then(() => this.renderExclusive(source, options?.includeImage === true));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async renderExclusive(source: string, includeImage: boolean): ReturnType<DiagramValidator['render']> {
    const validation = check(source);
    if (validation.syntax !== 'ok') return { validation };
    let browser: Browser | undefined;
    let page: Page | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        const launched = await (await import('playwright')).chromium.launch({ headless: true });
        browser = launched;
        if (expired) {
          await launched.close();
          throw new Error('Таймаут запуска браузера');
        }
        page = await launched.newPage();
        const origin = new URL(this.baseUrl).origin;
        const host = `${origin}/__livenote_drawio_render__`;
        await page.route('**/*', async (route) => {
          const url = route.request().url();
          if (url === host) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
          } else if (new URL(url).origin === origin && new URL(url).pathname.startsWith('/drawio/')) {
            await route.continue();
          } else {
            await route.abort();
          }
        });
        await page.goto(host);
        // Протокол возвращает исходный запрос в поле message.
        const script = `new Promise((resolve, reject) => {
          const frame = document.createElement('iframe');
          const requestId = 'livenote-render';
          window.addEventListener('message', (event) => {
            if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
            let msg; try { msg = JSON.parse(event.data); } catch { return; }
            if (msg.event === 'init') {
              frame.contentWindow.postMessage(JSON.stringify({action:'export', format:'svg', theme:'light', asText:true,
                embedImages:false, embedFonts:false, xml:${JSON.stringify(source)}, requestId}), location.origin);
            } else if (msg.event === 'export' && msg.message && msg.message.requestId === requestId) {
              if (typeof msg.data === 'string' && msg.data.includes('<svg')) resolve(msg.data);
              else reject(new Error('draw.io не вернул SVG'));
            }
          });
          frame.src = '/drawio/index.html?embed=1&proto=json&offline=1&noSaveBtn=1&noExitBtn=1&saveAndExit=0&contrast=0';
          document.body.appendChild(frame);
        })`;
        const svg = await page.evaluate<string>(script);
        const result: { svg: string; pngBase64?: string } = { svg };
        if (includeImage) {
          const imagePage = await launched.newPage();
          await imagePage.route('**/*', (route) => route.abort());
          try {
            await imagePage.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
            result.pngBase64 = (await imagePage.locator('svg').first().screenshot({ type: 'png', omitBackground: true })).toString('base64');
          } finally {
            await imagePage.close();
          }
        }
        return { validation, render: result };
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('Таймаут рендера draw.io'));
        }, TIMEOUT_MS);
      });
      return await Promise.race([operation, timeout]);
    } catch (error) {
      console.error('[livenote] Рендер draw.io недоступен:', error instanceof Error ? error.message : error);
      return { validation: unavailable };
    } finally {
      if (timer) clearTimeout(timer);
      await page?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}

export async function createDrawioValidator(options: { baseUrl: string }): Promise<DiagramValidator> {
  return new DrawioValidator(options.baseUrl);
}
