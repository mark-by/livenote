import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import express from 'express';
import { createDrawioValidator } from '../src/server/validator/drawio.js';

const model = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Привет" vertex="1" parent="1"><mxGeometry x="10" y="10" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>';
const compressed = deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
const document = `<mxfile><diagram>${compressed}</diagram><diagram>${model}</diagram><diagram/></mxfile>`;

test('проверка всех страниц без браузера', async () => {
  const validator = await createDrawioValidator({ baseUrl: 'http://127.0.0.1:1' });
  for (const source of [model, document, '<mxfile><diagram/></mxfile>']) {
    assert.equal((await validator.parse(source)).syntax, 'ok');
  }
  for (const source of [
    '<mxfile><diagram><mxGraphModel></diagram></mxfile>',
    `<mxfile><diagram>${compressed}</diagram><diagram>broken!</diagram></mxfile>`,
    '<!DOCTYPE mxfile [<!ENTITY x SYSTEM "file:///etc/passwd">]><mxfile>&x;</mxfile>',
    '<mxfile/><mxfile/>',
    '<other/>',
    `<mxfile><diagram>${deflateRawSync(Buffer.from(encodeURIComponent('<bad/>'))).toString('base64')}</diagram></mxfile>`,
    `<mxfile><diagram>${deflateRawSync(Buffer.alloc(17 * 1024 * 1024, 65)).toString('base64')}</diagram></mxfile>`
  ]) {
    assert.equal((await validator.parse(source)).syntax, 'error');
  }
});

test('локальный SVG и PNG первой страницы', async () => {
  const app = express();
  app.use('/drawio', express.static('src/web/public/drawio'));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const validator = await createDrawioValidator({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await validator.render(document, { includeImage: true });
    assert.equal(result.validation.syntax, 'ok');
    assert.match(result.render?.svg ?? '', /<svg\b/);
    assert.match(result.render?.svg ?? '', /Привет/);
    assert.deepEqual(Buffer.from(result.render?.pngBase64 ?? '', 'base64').subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
