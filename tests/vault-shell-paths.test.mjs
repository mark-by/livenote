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

test('Вставка в конце последней строки сохраняет её перед новым блоком', () => {
  // Arrange: заметка заканчивается непустой строкой без перевода строки.
  const source = 'Последняя строка';
  const block = '![[schema.drawio]]';

  // Act: вставить схему на правой границе строки.
  const inserted = insertBlockAt(source, source.length, block);

  // Assert: схема следует за существующим текстом.
  assert.equal(inserted.source, `${source}\n\n${block}\n`);
});

test('Вставка внутри строки из пробелов сохраняет выбранную позицию', () => {
  // Arrange: указатель стоит между двумя пробелами на пустой строке.
  const source = 'До\n  \nПосле';
  const position = source.indexOf('  ') + 1;
  const block = '![[schema.drawio]]';

  // Act: вставить схему в выбранную позицию.
  const inserted = insertBlockAt(source, position, block);

  // Assert: один пробел остаётся перед схемой, другой — после неё.
  assert.equal(inserted.source, 'До\n \n\n![[schema.drawio]]\n\n \nПосле');
});

test('Вставка на первой пустой строке сохраняет схему в начале заметки', () => {
  // Arrange: заметка начинается с пустой строки.
  const source = '\nТекст';
  const block = '![[schema.drawio]]';

  // Act: вставить схему перед первым переводом строки.
  const inserted = insertBlockAt(source, 0, block);

  // Assert: до схемы нет пустой строки, текст начинается новым абзацем.
  assert.equal(inserted.source, `${block}\n\nТекст`);
});

test('Вставка между абзацами использует существующие переводы строк', () => {
  // Arrange: между абзацами есть две пустые строки.
  const source = 'До\n\n\nПосле';
  const position = source.indexOf('\n\n\n') + 2;
  const block = '![[schema.drawio]]';

  // Act: вставить схему в конце второй пустой строки.
  const inserted = insertBlockAt(source, position, block);

  // Assert: между схемой и каждым абзацем ровно одна пустая строка.
  assert.equal(inserted.source, `До\n\n${block}\n\nПосле`);
});

test('Вставка внутри непустой строки сохраняет пустые строки перед ней', () => {
  // Arrange: перед строкой с указателем есть две пустые строки.
  const source = 'До\n\n\nПосле\nДальше';
  const position = source.indexOf('\nДальше') - 1;
  const block = '![[schema.drawio]]';

  // Act: вставить схему у последней буквы непустой строки.
  const inserted = insertBlockAt(source, position, block);

  // Assert: схема предшествует строке, пустые строки остаются на месте.
  assert.equal(inserted.source, `До\n\n\n${block}\n\nПосле\nДальше`);
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
