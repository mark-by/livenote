import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { parseEditorDiagrams } from '../src/web/editor/parseDiagrams.ts';
import { diagramRenderer, diagramSelection } from '../src/web/editor/diagramExtension.ts';
import { parseEditorLinks } from '../src/web/editor/parseLinks.ts';
import { parseVaultDocument } from '../src/server/vaultDocument.ts';

test('Сохраняет точные UTF-16 диапазоны двух одинаковых Mermaid fences с CRLF', () => {
  const fence = '```mermaid\r\nflowchart LR\r\n  A --> B\r\n```';
  const source = `📝 До\r\n\r\n${fence}\r\n\r\nМежду\r\n\r\n${fence}\r\n`;

  const diagrams = parseEditorDiagrams(source);

  assert.deepEqual(diagrams, [
    { from: 9, to: 9 + fence.length, format: 'mermaid', source: 'flowchart LR\r\n  A --> B' },
    { from: source.lastIndexOf(fence), to: source.lastIndexOf(fence) + fence.length,
      format: 'mermaid', source: 'flowchart LR\r\n  A --> B' }
  ]);
});

test('Читает Markdown images, reference images и wiki embeds как относительные схемы', () => {
  const tokens = [
    '![Процесс](./Схемы/Приёмка.bpmn)',
    '![Обзор][обзор]',
    '![[../Схемы/Архитектура.drawio|Архитектура]]'
  ];
  const source = tokens.join('\n\n') + '\n\n[обзор]: ./Обзор.mmd\n';

  const diagrams = parseEditorDiagrams(source);

  assert.deepEqual(diagrams.map(({ from, to, ...diagram }) => ({
    token: source.slice(from, to), ...diagram
  })), [
    { token: tokens[0], format: 'bpmn', source: '', target: './Схемы/Приёмка.bpmn', label: 'Процесс' },
    { token: tokens[1], format: 'mermaid', source: '', target: './Обзор.mmd', label: 'Обзор' },
    { token: tokens[2], format: 'drawio', source: '', target: '../Схемы/Архитектура.drawio', label: 'Архитектура' }
  ]);
});

test('Исключает code, escaped syntax, HTML и сетевые назначения из диаграмм', () => {
  const source = [
    '`![[inline.bpmn]]`',
    '```text\n![[code.drawio]]\n```',
    '\\![[escaped.bpmn]]',
    '<div>\n![[html.bpmn]]\n</div>',
    '![Сеть](https://example.test/network.bpmn)',
    '![[https://example.test/remote.drawio]]',
    '\\![Изображение](./escaped.mmd)',
    '![[./real.mermaid]]'
  ].join('\n\n');

  const diagrams = parseEditorDiagrams(source);

  assert.deepEqual(diagrams, [{
    from: source.indexOf('![[./real.mermaid]]'), to: source.length,
    format: 'mermaid', source: '', target: './real.mermaid'
  }]);
});

test('Сохраняет незакрытый Mermaid fence и четыре символа closing fence', () => {
  const cases = [
    { source: '````mermaid\nA --> B\n````', content: 'A --> B' },
    { source: '~~~mermaid\nA --> B\n~~~', content: 'A --> B' },
    { source: '```mermaid\nA --> B\n', content: 'A --> B\n' }
  ];

  for (const fixture of cases) {
    const diagrams = parseEditorDiagrams(fixture.source);

    assert.deepEqual(diagrams, [{
      from: 0, to: fixture.source.length, format: 'mermaid', source: fixture.content
    }]);
  }
});

test('BPMN и draw.io fences остаются кодом, inline embeds сохраняют точные диапазоны', () => {
  const source = '```bpmn\n<definitions />\n```\n\n```drawio\n<mxfile />\n```\n\nДо ![A](./a.bpmn) между ![A](./a.bpmn) после.';
  const first = source.indexOf('![A]');
  const last = source.lastIndexOf('![A]');

  const diagrams = parseEditorDiagrams(source);

  assert.deepEqual(diagrams, [first, last].map(from => ({
    from, to: from + '![A](./a.bpmn)'.length,
    format: 'bpmn', source: '', target: './a.bpmn', label: 'A'
  })));
});

test('Markdown и wiki ссылки возвращают цель отдельно от маркеров и подписи', () => {
  const source = '[Документ](./Другой.md#раздел) и [[Работа/План.md|План]], `[[код]]`, \\[[не ссылка]].';

  const links = parseEditorLinks(source);

  assert.deepEqual(links.map(link => ({
    target: link.target, label: source.slice(link.labelFrom, link.labelTo), wiki: link.wiki
  })), [
    { target: './Другой.md#раздел', label: 'Документ', wiki: false },
    { target: 'Работа/План.md', label: 'План', wiki: true }
  ]);
});

test('Editor и native vault совпадают по UTF-16 spans и точному содержимому Mermaid', () => {
  const fixtures = [
    '📝\r\n\r\n````mermaid\r\nA --> B\r\n````\r\n\r\n```mermaid\r\nA --> B\r\n```',
    'До ![A](./a.bpmn) между ![A](./a.bpmn) после.\n\n![[./Архитектура.drawio|Схема]]',
    '![Обзор][ref]\n\n[ref]: ./Обзор.mmd\n\n![Encoded](./drawing%2Ebpmn)',
    '`![[код.bpmn]]`\n\n\\![[escaped.drawio]]\n\n![Сеть](https://example.test/a.bpmn)',
    '```bpmn\n<definitions />\n```\n\n```drawio\n<mxfile />\n```\n\n```Mermaid\nA-->B\n```\n\n``` mermaid\nA-->B\n```'
  ];

  for (const source of fixtures) {
    const editor = parseEditorDiagrams(source).map(({ from, to, format, source: content }) => ({
      from, to, format, content
    }));
    const native = parseVaultDocument(source, 'Работа/Заметка.md', () => ({ source: '<fixture />' }))
      .document.spans.filter(span => span.type !== 'markdown').map(span => ({
        from: span.from, to: span.to, format: span.type,
        content: span.assetPath ? '' : source.slice(span.sourceFrom, span.sourceTo)
      }));

    assert.deepEqual(editor, native, source);
  }
});

test('Прямой selection Vim перескакивает скрытый исходник, сохраняя выделение снаружи', () => {
  const source = 'До\n\n```mermaid\nA --> B\n```\n\nПосле';
  const from = source.indexOf('```');
  const to = source.lastIndexOf('```') + 3;
  const state = EditorState.create({
    doc: source,
    extensions: [diagramRenderer.of(() => null), diagramSelection]
  });

  const moved = state.update({ selection: { anchor: 0, head: from + 5 } }).state;

  assert.deepEqual({ anchor: moved.selection.main.anchor, head: moved.selection.main.head }, {
    anchor: 0, head: to
  });
});
