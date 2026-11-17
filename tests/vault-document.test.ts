import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVaultDocument, fingerprint, hasGitConflict, fileVersion } from '../src/server/vaultDocument.ts';
import { linkSpans, resolveLinks, rewritePaths } from '../src/server/vaultLinks.ts';

const head = '---\nid: duplicate\ntitle: Old title\n# keep this\nunknown: {x: 2}\naliases: [Uno]\ntags: [work]\n---\n';
const parse = (source: string, path = 'Folder/One.md') => parseVaultDocument(source, path, () => ({ source: '<xml />' }));

test('ordinary Markdown and optional YAML preserve all bytes and use path identity', () => {
  for (const source of ['', '# Hello\n\nbody', head + '# Hello\n', ('\uFEFF' + head + 'body\n').replace(/\n/g, '\r\n')]) {
    const parsed = parse(source);
    assert.equal(parsed.document.source, source);
    assert.equal(parsed.document.page.id, 'Folder/One.md');
    assert.equal(parsed.document.page.title, 'One');
    assert.equal(parsed.document.assets.length, 0);
    assert.equal(parse(source).document.version, parsed.document.version);
    assert.equal(parsed.document.spans.map(span => source.slice(span.from, span.to)).join(''), source);
  }
  assert.equal(parse('').document.page.blocks.length, 0);
  assert.deepEqual(parse(head).document.aliases, ['Uno']);
});

test('unknown YAML, duplicate legacy IDs and comments remain ordinary source', () => {
  const source = head.replace(/\n/g, '\r\n') + '\r\n# Body #новый/тег\r\n';
  const document = parse(source).document;
  assert.equal(document.page.blocks[0]?.source, source);
  assert.deepEqual(document.tags, ['work', 'новый/тег']);
  assert.equal(parse(head, 'Other/One.md').document.page.id, 'Other/One.md');
});

test('invalid optional metadata does not prevent reading and editing native Markdown', () => {
  for (const source of ['---\nid: x\nid: y\n---\n', '---\nx: !unsafe {}\n---\n', '---\ntags: nope\n---\n']) {
    assert.equal(parse(source).document.source, source);
    assert.equal(parse(source).document.page.id, 'Folder/One.md');
  }
});

test('identical Mermaid fences have distinct revision-local ranges with exact Unicode and CRLF', () => {
  const fence = '~~~~mermaid\r\nflowchart LR\r\n Привет --> 🧭\r\n~~~~';
  const source = '\uFEFFbefore\r\n\r\n' + fence + '\r\n\r\n' + fence + '\r\nlast';
  const parsed = parse(source);
  assert.deepEqual(parsed.document.page.blocks.map(block => block.type), ['markdown', 'mermaid', 'markdown', 'mermaid', 'markdown']);
  assert.deepEqual(parsed.document.page.blocks.filter(block => block.type === 'mermaid').map(block => block.id), ['span-1', 'span-3']);
  for (const span of parsed.document.spans.filter(span => span.type === 'mermaid')) {
    assert.equal(source.slice(span.from, span.to), fence);
    assert.equal(source.slice(span.sourceFrom, span.sourceTo), 'flowchart LR\r\n Привет --> 🧭');
  }
  assert.equal(parsed.document.spans.map(span => source.slice(span.from, span.to)).join(''), source);
});

test('nested fences and escaped syntax exclude diagrams links and tags in code', () => {
  const source = '````text\n```mermaid\nflowchart LR\n```\n![[fake.drawio]] #код\n````\n`![[inline.drawio]] #inline` \\![[escaped.drawio]]\n# Heading\n#тег #тег #вложенный/тег https://host/#url [#link](https://host)\n';
  const parsed = parse(source);
  assert.deepEqual(parsed.document.page.blocks.map(block => block.type), ['markdown']);
  assert.deepEqual(parsed.document.tags, ['тег', 'вложенный/тег']);
  assert.equal(parsed.document.page.blocks[0]?.source, source);
});

test('Markdown wiki and reference embeds resolve relative shared assets without markers', () => {
  const xml = '<?xml version="1.0"?>\r\n<mxfile>  </mxfile>';
  const source = 'before ![Architecture](../Схемы/A.drawio) after\n![[../Схемы/A.drawio|Shared]]\n![Flow][diagram]\n\n[diagram]: <../Схемы/Flow.mmd> "title"\n';
  const parsed = parseVaultDocument(source, 'Folder/One.md', path => ({ source: path.endsWith('.mmd') ? 'flowchart LR\n A-->B' : xml }));
  assert.deepEqual(parsed.document.page.blocks.filter(block => block.type !== 'markdown').map(block => [block.type, block.title, block.source]), [
    ['drawio', 'Architecture', xml], ['drawio', 'Shared', xml], ['mermaid', 'Flow', 'flowchart LR\n A-->B']
  ]);
  assert.equal(parsed.document.assets.length, 2);
  assert.deepEqual(parsed.document.assets.map(asset => asset.path), ['Схемы/A.drawio', 'Схемы/Flow.mmd']);
  assert.equal(parsed.document.assets[0]?.version, fileVersion(xml));
  assert.equal(parsed.document.spans.map(span => source.slice(span.from, span.to)).join(''), source);
});

test('missing diagrams stay visible with null manifest source and network embeds are not fetched', () => {
  const loaded: string[] = [];
  const parsed = parseVaultDocument('![missing](Absent.bpmn)\n![remote](https://host/A.drawio)', 'Note.md', path => { loaded.push(path); throw new Error('missing'); });
  assert.deepEqual(loaded, ['Absent.bpmn']);
  assert.deepEqual(parsed.document.assets, [{ path: 'Absent.bpmn', type: 'bpmn', source: null, version: null }]);
  assert.equal(parsed.document.page.blocks[0]?.source, '');
  assert.equal(parsed.problems[0]?.code, 'missing_asset');
});

test('asset manifest deduplicates paths and distinguishes missing type path and exact source', () => {
  const asset = { type: 'drawio' as const, path: 'A.drawio', source: 'ab', version: fileVersion('ab') };
  assert.equal(fingerprint('a.md', 'b', [asset, asset]).version, fingerprint('a.md', 'b', [asset]).version);
  assert.notEqual(fingerprint('a.md', 'b', [asset]).version, fingerprint('a.md', 'b', [{ ...asset, source: null, version: null }]).version);
  assert.notEqual(fingerprint('a.md', 'b', [asset]).version, fingerprint('a.md', 'b', [{ ...asset, source: 'a' }]).version);
  assert.notEqual(fingerprint('a.md', 'b', []).version, fingerprint('b.md', 'a', []).version);
  assert.match(fingerprint('a.md', 'b', []).version, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(fingerprint('a.md', 'b', []).revision));
});

test('CommonMark destination ranges rewrite references and relative wiki links once outside code', () => {
  const source = '\\[[escaped]] `[[inline]]`\n\n```\n[[fenced]]\n```\n\n[[Two#intro|Two]] [two](Two.md#x) ![image](Two.md) [a][ref] [b][ref]\n\n[ref]: <Two.md#ref> "title"\n';
  const spans = linkSpans(source);
  assert.equal(spans.length, 4);
  const one = parse(source); const two = parse('', 'Folder/Two.md');
  const resolved = resolveLinks(one.document, [one.document, two.document]);
  assert.deepEqual(resolved.map(link => link.targetPageId), Array(4).fill('Folder/Two.md'));
  const rewritten = rewritePaths(one.document, resolved, new Map([['Folder/Two.md', 'Moved/Two.md']]));
  assert.match(rewritten, /\[\[\.\.\/Moved\/Two.md#intro\|Two\]\]/);
  assert.match(rewritten, /\[ref\]: <\.\.\/Moved\/Two.md#ref> "title"/);
  assert.match(rewritten, /`\[\[inline\]\]`/);
});

test('only complete Git marker groups quarantine a document', () => {
  assert.equal(hasGitConflict('Title\n=======\n'), false);
  assert.throws(() => parse('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n'), /Git/);
});

test('standalone diagrams project one exact source span without self-referenced assets', () => {
  for (const path of ['Flow.mmd', 'Flow.mermaid', 'Process.bpmn', 'Architecture.drawio']) {
    const source = '\uFEFFsource\r\nno final newline';
    const parsed = parse(source, path);
    assert.equal(parsed.document.page.blocks[0]?.source, source);
    assert.deepEqual(parsed.document.assets, []);
    assert.deepEqual(parsed.document.spans.map(span => [span.from, span.to, span.sourceFrom, span.sourceTo]), [[0, source.length, 0, source.length]]);
  }
});
