import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendInlineTag, insertBlockAt, mermaidFence, nextAssetPath, relativeVaultPath,
  remapPath, resolveDiagramAsset, resolveVaultPath
} from '../src/web/vault/vaultPaths.ts';

test('relative diagram destinations stay inside the vault and round-trip', () => {
  const document = 'Работа/Заметки/Приёмка.md';
  const target = 'Работа/Схемы/Общий процесс.bpmn';
  const relative = relativeVaultPath(document, target);
  assert.equal(relative, '../Схемы/Общий процесс.bpmn');
  assert.equal(resolveVaultPath(document, relative), target);
  assert.equal(resolveVaultPath(document, '../../../outside.bpmn'), null);
  assert.equal(resolveVaultPath(document, 'https://example.test/a.bpmn'), null);
});

test('block insertion moves to the line boundary instead of splitting prose', () => {
  const source = 'Первая строка\nВторая строка\n\nПосле';
  const position = source.indexOf('строка\n\nПосле');
  const inserted = insertBlockAt(source, position, '![[schema.bpmn]]');
  assert.equal(inserted.source, 'Первая строка\n\n![[schema.bpmn]]\n\nВторая строка\n\nПосле');
  assert.equal(`${source.slice(0, inserted.edit.from)}${inserted.edit.text}${source.slice(inserted.edit.to)}`, inserted.source);
});

test('Mermaid fences outgrow backticks in source and preserve source bytes', () => {
  const fence = mermaidFence('flowchart LR\n  A["```"] --> B\n');
  assert.match(fence, /^````mermaid\n/);
  assert.match(fence, /A\["```"\] --> B\n````$/);
});

test('asset names are readable, deterministic and collision-free', () => {
  assert.equal(nextAssetPath('Работа/Приёмка.md', 'bpmn', ['Схемы/Приёмка — Процесс.bpmn']), 'Схемы/Приёмка — Процесс 2.bpmn');
});

test('inline tags become ordinary Markdown at EOF without duplicate separators', () => {
  assert.equal(appendInlineTag('Текст\n', ' #проект/приёмка '), 'Текст\n\n#проект/приёмка\n');
  assert.equal(appendInlineTag('Текст', '   '), 'Текст');
});

test('dirty embed target resolution never falls back to the saved same-range asset', () => {
  const document = {
    path: 'Note.md',
    spans: [{ from: 0, to: 20, assetPath: 'A.drawio' }],
    assets: [{ path: 'A.drawio', source: 'old A' }, { path: 'B.drawio', source: 'current B' }]
  };
  assert.equal(resolveDiagramAsset(document, { from: 0, to: 20, target: './B.drawio' })?.source, 'current B');
  assert.equal(resolveDiagramAsset(document, { from: 0, to: 20, target: './C.drawio' }), undefined);
});

test('move results remap open paths by exact file and longest folder prefix', () => {
  const moved = [{ from: 'Работа', to: 'Архив/Работа' }, { from: 'Работа/Приёмка.md', to: 'Особое.md' }];
  assert.equal(remapPath('Работа/Приёмка.md', moved), 'Особое.md');
  assert.equal(remapPath('Работа/Черновики/План.md', moved), 'Архив/Работа/Черновики/План.md');
});
