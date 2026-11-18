import type { DiagramValidation } from '../../shared/types';
import { invalid } from './protocol';

const MAX_XML_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const parser = new DOMParser();

class DrawioXmlError extends Error {}

function xml(source: string): Element {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) {
    throw new DrawioXmlError('Объявления DTD и сущностей запрещены');
  }
  const root = parser.parseFromString(source, 'application/xml').documentElement;
  if (root.localName === 'parsererror' && root.namespaceURI === 'http://www.mozilla.org/newlayout/xml/parsererror.xml') {
    throw new DrawioXmlError(root.textContent || 'Некорректный XML');
  }
  return root;
}

export async function validateDrawio(source: string): Promise<DiagramValidation> {
  try {
    let size = encoder.encode(source).byteLength;
    if (size > MAX_XML_BYTES) throw new DrawioXmlError('Превышен размер XML');
    const root = xml(source);
    switch (root.tagName) {
      case 'mxGraphModel':
        break;
      case 'mxfile':
        for (const diagram of root.children) {
          if (diagram.tagName !== 'diagram') throw new DrawioXmlError('Неизвестный элемент mxfile');
          if (diagram.childElementCount > 0) {
            if (diagram.childElementCount !== 1 || diagram.firstElementChild?.tagName !== 'mxGraphModel') {
              throw new DrawioXmlError('Ожидается mxGraphModel внутри diagram');
            }
            continue;
          }
          const encoded = (diagram.textContent ?? '').replace(/\s/g, '');
          if (encoded.length === 0) continue;
          if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
            throw new DrawioXmlError('Некорректный base64 страницы');
          }
          const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
          const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let compressedText = '';
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > MAX_XML_BYTES) throw new DrawioXmlError('Превышен размер страниц');
              compressedText += decoder.decode(chunk.value, { stream: true });
            }
            compressedText += decoder.decode();
          } finally {
            await reader.cancel();
          }
          const decoded = decodeURIComponent(compressedText);
          size += encoder.encode(decoded).byteLength;
          if (size > MAX_XML_BYTES) throw new DrawioXmlError('Превышен размер страниц');
          if (xml(decoded).tagName !== 'mxGraphModel') throw new DrawioXmlError('Ожидается mxGraphModel страницы');
        }
        break;
      default:
        throw new DrawioXmlError('Ожидается mxfile или mxGraphModel');
    }
    return { syntax: 'ok', renderer: 'playwright', diagramType: 'drawio' };
  } catch (error) {
    return invalid(error);
  }
}
