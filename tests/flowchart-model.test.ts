import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFlowchartEdit as edit, FlowchartEditError, readFlowchart } from '../src/web/flowchart/index.ts';

function model(source: string) {
  const result = readFlowchart(source);
  assert.ok(result, `Ожидалась редактируемая блок-схема:\n${source}`);
  return result;
}

test('Читает направление, подписи, цепочки, формы и неявные узлы', () => {
  const source = `graph LR
  A["First; | #quot;quoted#quot;"] -->|yes| B{Decision} -.-> C((Done))
  C == strong ==> D
  D --- E
`;
  assert.deepEqual(model(source), {
    direction: 'LR',
    nodes: [
      { id: 'A', label: 'First; | "quoted"' }, { id: 'B', label: 'Decision' },
      { id: 'C', label: 'Done' }, { id: 'D', label: 'D' }, { id: 'E', label: 'E' },
    ],
    edges: [
      { id: 'edge-0', from: 'A', to: 'B', label: 'yes' },
      { id: 'edge-1', from: 'B', to: 'C', label: '' },
      { id: 'edge-2', from: 'C', to: 'D', label: 'strong' },
      { id: 'edge-3', from: 'D', to: 'E', label: '' },
    ],
  });
});

test('Меняет подпись, сохраняя подграфы, направления, стили и комментарии', () => {
  const source = `%%{init: {"theme": "dark"}}%%
flowchart TD
  %% untouched comment
  subgraph zone [The zone]
    direction LR
    A{"Old"}:::choice --> B["B"]
  end
  style A fill:#fff,stroke:#333
  classDef choice fill:#eee
  class A,B choice
  linkStyle 0 stroke:red
`;
  const updated = edit(source, { type: 'renameNode', id: 'A', label: 'New "quoted" # label' });
  assert.equal(updated, source.replace('{"Old"}', '{"New #quot;quoted#quot; #35; label"}'));
  assert.equal(model(updated).nodes[0]!.label, 'New "quoted" # label');
});

test('Меняет повторные объявления и подпись неявного узла', () => {
  const source = 'flowchart LR; A --> B; A[One] --> C; A(Two)';
  const updated = edit(source, { type: 'renameNode', id: 'A', label: 'Shared' });
  assert.equal(updated, 'flowchart LR; A --> B; A["Shared"] --> C; A("Shared")');
  assert.equal(edit('flowchart LR; A:::hot --> B', { type: 'renameNode', id: 'A', label: 'Start' }),
    'flowchart LR; A["Start"]:::hot --> B');
});

test('Сохраняет поддерживаемые формы узлов при изменении подписи', () => {
  const shapes = ['[old]', '(old)', '((old))', '(((old)))', '([old])', '[(old)]', '[[old]]',
    '{old}', '{{old}}', '>old]', '[/old/]', '[\\old\\]', '[/old\\]', '[\\old/]', '(-old-)'];
  for (const shape of shapes) {
    const source = `flowchart TB\nA${shape}`;
    const updated = edit(source, { type: 'renameNode', id: 'A', label: 'changed' });
    assert.equal(updated, source.replace('old', '"changed"'));
    assert.equal(model(updated).nodes[0]!.label, 'changed');
  }
});

test('Добавляет узлы и связи вне подграфов, сохраняя CRLF и комментарий', () => {
  const source = 'flowchart BT\r\nsubgraph group\r\n A\r\nend\r\n%% last comment';
  const withNode = edit(source, { type: 'addNode', id: 'new-node', label: 'New; node' });
  assert.equal(withNode, source + '\r\n  new-node["New; node"]\r\n');
  const withEdge = edit(withNode, { type: 'addEdge', from: 'A', to: 'new-node', label: 'a | b' });
  assert.equal(withEdge, withNode + '  A -->|"a | b"| new-node\r\n');
  assert.deepEqual(model(withEdge).edges, [{ id: 'edge-0', from: 'A', to: 'new-node', label: 'a | b' }]);
});

test('Меняет подписи связей без изменения остальных участков исходника', () => {
  for (const connector of ['-->|before|', '-- before -->', '-. before .->', '== before ==>']) {
    const source = `flowchart LR\n  A ${connector} B --> C %% keep\n`;
    const updated = edit(source, { type: 'updateEdgeLabel', id: 'edge-0', label: 'New "value" |' });
    assert.equal(model(updated).edges[0]!.label, 'New "value" |');
    assert.ok(updated.endsWith(' B --> C %% keep\n'));
    const cleared = edit(updated, { type: 'updateEdgeLabel', id: 'edge-0', label: '' });
    assert.equal(model(cleared).edges[0]!.label, '');
    assert.equal(model(cleared).edges.length, 2);
  }
});

test('Сохраняет идентификаторы связей при изменении подписей', () => {
  const source = 'flowchart LR\nA route@-->|old| B\nclass route hot';
  assert.equal(edit(source, { type: 'updateEdgeLabel', id: 'edge-0', label: 'new' }),
    'flowchart LR\nA route@-->|"new"| B\nclass route hot');
});

test('Сохраняет переносы строк, кавычки и решётки в новых подписях', () => {
  const label = 'First line\nSecond "quoted" #quot; #35; | end';
  let source = edit('flowchart TD\nA --> B', { type: 'renameNode', id: 'A', label });
  assert.equal(model(source).nodes[0]!.label, label);
  source = edit(source, { type: 'updateEdgeLabel', id: 'edge-0', label });
  assert.equal(model(source).edges[0]!.label, label);
  source = edit(source, { type: 'addNode', id: 'C', label });
  assert.equal(model(source).nodes[2]!.label, label);
});

test('Меняет подписи ненаправленных связей, сохраняя их тип', () => {
  const source = 'flowchart LR\nA --- B';
  assert.equal(model(source).edges.length, 1);
  assert.equal(edit(source, { type: 'updateEdgeLabel', id: 'edge-0', label: 'link' }),
    'flowchart LR\nA ---|"link"| B');
});

test('Сохраняет разделитель после направления при удалении связи', () => {
  const source = 'flowchart LR; A[Alpha] --> B[Beta]';
  const updated = edit(source, { type: 'removeEdge', id: 'edge-0' });
  assert.equal(updated, 'flowchart LR; A[Alpha]; B[Beta]');
  assert.equal(model(updated).nodes.length, 2);
});

test('Удаляет связь из цепочки, сохраняя узлы и объявления', () => {
  const source = `flowchart LR
  A[Alpha] -->|one| B(Beta) -->|two| C{Gamma} --> D
  X --> Y
  %% unchanged
`;
  const updated = edit(source, { type: 'removeEdge', id: 'edge-1' });
  assert.equal(updated, source.replace('B(Beta) -->|two| C{Gamma}', 'B(Beta); C{Gamma}'));
  assert.deepEqual(model(updated).nodes, model(source).nodes);
  assert.deepEqual(model(updated).edges.map(({ from, to }) => [from, to]), [['A', 'B'], ['C', 'D'], ['X', 'Y']]);
});

test('Удаляет все упоминания узла и его связи внутри подграфов', () => {
  const source = `flowchart TD
  subgraph group
    A[Alpha] --> B[Beta] --> C[Gamma]
    B --> D
  end
  E --> B
  style B fill:red
  class A,B,C hot
  click B "https://example.test"
  linkStyle 0,1,2,3 stroke:red
  classDef hot fill:blue
`;
  const updated = edit(source, { type: 'removeNode', id: 'B' });
  assert.deepEqual(model(updated).nodes.map(({ id }) => id), ['A', 'C', 'D', 'E']);
  assert.deepEqual(model(updated).edges, []);
  assert.ok(updated.includes('A[Alpha]; C[Gamma]'));
  assert.ok(updated.includes('class A,C hot'));
  assert.ok(updated.includes('classDef hot fill:blue'));
  assert.ok(updated.includes('subgraph group\n'));
  assert.ok(!updated.includes('style B'));
  assert.ok(!updated.includes('click B'));
  assert.ok(!updated.includes('linkStyle'));
});

test('Пересчитывает linkStyle и удаляет ссылки на удалённые связи', () => {
  const source = `flowchart TD
A first@--> B --> C --> D
linkStyle 0,2 stroke:red
linkStyle 1 stroke:blue
linkStyle default stroke:black
class first hot
style first stroke:red
`;
  const updated = edit(source, { type: 'removeEdge', id: 'edge-0' });
  assert.ok(updated.includes('linkStyle 1 stroke:red'));
  assert.ok(updated.includes('linkStyle 0 stroke:blue'));
  assert.ok(updated.includes('linkStyle default stroke:black'));
  assert.ok(!updated.includes('class first'));
  assert.ok(!updated.includes('style first'));
  assert.equal(model(updated).edges.length, 2);
});

test('Учитывает пробелы в списках классов и индексах linkStyle', () => {
  const source = 'flowchart LR\nA --> B --> C\nclass A, B, C hot\nlinkStyle 0, 1 stroke:red';
  const updated = edit(source, { type: 'removeNode', id: 'A' });
  assert.ok(updated.includes('class B,C hot'));
  assert.ok(updated.includes('linkStyle 0 stroke:red'));
  assert.deepEqual(model(updated).nodes.map(({ id }) => id), ['B', 'C']);
});

test('Отклоняет неподдерживаемые конструкции без частичного редактирования', () => {
  for (const source of [
    'sequenceDiagram\nA->>B: Hi',
    'flowchart LR\nA & B --> C',
    'flowchart LR\nA@{ shape: rect, label: "Hello" }',
    'flowchart LR\nA --> B\nB@{ shape: circle }',
    'flowchart LR\nsubgraph group\nA\nend\ngroup --> B',
    'flowchart LR\nsubgraph group\nA',
    'flowchart LR\nA["unterminated]',
    'flowchart LR\nA -->|unterminated B',
    'flowchart LR\nA --> B\nunknownDirective hi',
    'flowchart LR A --> B',
  ]) {
    assert.equal(readFlowchart(source), null, source);
    assert.throws(() => edit(source, { type: 'addNode', id: 'Added', label: 'No' }), FlowchartEditError);
  }
});

test('Отклоняет неизвестные, повторные и недопустимые идентификаторы', () => {
  const source = 'flowchart TD\nA --> B';
  for (const action of [
    { type: 'renameNode', id: 'Missing', label: 'x' },
    { type: 'addNode', id: 'A', label: 'x' },
    { type: 'addNode', id: 'end', label: 'x' },
    { type: 'addNode', id: 'A --> B', label: 'x' },
    { type: 'removeNode', id: 'Missing' },
    { type: 'addEdge', from: 'A', to: 'Missing' },
    { type: 'removeEdge', id: 'edge-99' },
    { type: 'updateEdgeLabel', id: 'edge-99', label: 'x' },
  ] as const) {
    assert.throws(() => edit(source, action), FlowchartEditError);
  }
  assert.throws(() => edit('flowchart LR\nsubgraph group\nA\nend',
    { type: 'addNode', id: 'group', label: 'Collision' }), FlowchartEditError);
});
