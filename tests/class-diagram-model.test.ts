import assert from 'node:assert/strict';
import test from 'node:test';
import { applyClassDiagramEdit as edit, ClassDiagramEditError, readClassDiagram } from '../src/web/classDiagram/index.ts';

const source = `classDiagram
direction BT
%% комментарий
class cells {
 bigint cell_type_id
 boolean closed_for_placing
}
class racks["Стеллаж"] {
 bigint rack_id
}
cells "1" --> "*" racks : содержит
cells : +find()
style cells fill:red
cssClass cells,racks hot
classDef hot fill:blue
`;

test('Читает классы, элементы, псевдонимы и связи с кардинальностями', () => {
  assert.deepEqual(readClassDiagram(source), {
    direction: 'BT',
    nodes: [
      { id: 'cells', label: 'cells', members: ['bigint cell_type_id', 'boolean closed_for_placing', '+find()'] },
      { id: 'racks', label: 'Стеллаж', members: ['bigint rack_id'] },
    ],
    edges: [{ id: 'edge-0', from: 'cells', to: 'racks', relation: '-->', label: 'содержит' }],
  });
});

test('Меняет подпись, тип и элементы, сохраняя незатронутые участки', () => {
  assert.equal(edit(source, { type: 'renameNode', id: 'cells', label: 'Ячейка' }), source.replace('class cells {', 'class cells["Ячейка"] {'));
  const updated = edit(source, { type: 'updateRelation', id: 'edge-0', relation: '*--' });
  assert.equal(updated, source.replace('"1" --> "*" ', '"1" *-- "*" '));
  const labeled = edit(updated, { type: 'updateEdgeLabel', id: 'edge-0', label: 'новая' });
  assert.equal(labeled, updated.replace(': содержит', ': новая'));
  const members = edit(source, { type: 'updateMembers', id: 'cells', members: ['+open()', 'int count'] });
  assert.deepEqual(readClassDiagram(members)?.nodes[0]?.members, ['+open()', 'int count']);
  assert.ok(members.includes('%% комментарий\n'));
  assert.ok(members.includes(' bigint rack_id\n'));
});

test('Удаляет класс, связи и ссылки на стили, оставляя прочие данные', () => {
  const updated = edit(source, { type: 'removeNode', id: 'cells' });
  assert.deepEqual(readClassDiagram(updated)?.nodes.map((item) => item.id), ['racks']);
  assert.deepEqual(readClassDiagram(updated)?.edges, []);
  assert.ok(updated.includes('cssClass racks hot'));
  assert.ok(updated.includes('classDef hot fill:blue'));
  assert.ok(updated.includes('%% комментарий'));
  assert.ok(!updated.includes('style cells'));
});

test('Сохраняет неявные классы при удалении связи', () => {
  const updated = edit('classDiagram\nA --> B\n', { type: 'removeEdge', id: 'edge-0' });
  assert.deepEqual(readClassDiagram(updated)?.nodes.map((item) => item.id), ['A', 'B']);
});

test('Поддерживает все типы связей и обратные операторы', () => {
  for (const op of ['<|--', '--|>', '*--', '--*', 'o--', '--o', '-->', '<--', '--', '..>', '<..', '..|>', '<|..', '..']) {
    const text = `classDiagram\nA ${op} B\n`;
    assert.equal(readClassDiagram(text)?.edges[0]?.relation, op);
  }
});

test('Отклоняет неизвестный синтаксис и небезопасные изменения', () => {
  for (const text of ['classDiagram\nA --> B --> C', 'classDiagram\nunknown stuff', 'classDiagram\nclass A {\n x\n']) {
    assert.equal(readClassDiagram(text), null);
    assert.throws(() => edit(text, { type: 'addNode', id: 'B', label: 'B' }), ClassDiagramEditError);
  }
  for (const member of ['x\nclass Evil', 'x }', 'x; class Evil', '%% comment']) {
    assert.throws(() => edit(source, { type: 'updateMembers', id: 'cells', members: [member] }), ClassDiagramEditError);
  }
  assert.throws(() => edit('classDiagram\nnamespace area {\nclass A\n}\n', { type: 'addNode', id: 'area', label: 'area' }), ClassDiagramEditError);
});

test('Меняет подпись класса с идентификатором из букв ключевого слова class', () => {
  // Arrange: идентификатор встречается и в ключевом слове.
  const original = 'classDiagram\nclass c {\n int value\n}\n';
  // Act: подпись добавляют к идентификатору, сохраняя объявление.
  const updated = edit(original, { type: 'renameNode', id: 'c', label: 'Ячейка' });
  // Assert: ключевое слово не повреждено.
  assert.equal(updated, 'classDiagram\nclass c["Ячейка"] {\n int value\n}\n');
});

test('Очищает элементы неявного класса, сохраняя сам класс', () => {
  // Arrange: класс определён только через элемент.
  const original = 'classDiagram\ncell : int id\n';
  // Act: пользователь удаляет весь текст из поля элементов.
  const updated = edit(original, { type: 'updateMembers', id: 'cell', members: [''] });
  // Assert: пустое поле не удаляет класс.
  assert.deepEqual(readClassDiagram(updated)?.nodes, [{ id: 'cell', label: 'cell', members: [] }]);
});

test('Разрешает пустые строки между элементами класса', () => {
  // Arrange: текстовое поле содержит пустую строку и завершающий перенос.
  const original = 'classDiagram\nclass cell {\n int old\n}\n';
  // Act: пользователь вводит два элемента в отдельных строках.
  const updated = edit(original, { type: 'updateMembers', id: 'cell', members: ['int id', '', '+open()', ''] });
  // Assert: модель содержит только элементы, без служебных пустых строк.
  assert.deepEqual(readClassDiagram(updated)?.nodes[0]?.members, ['int id', '+open()']);
});
