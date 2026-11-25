import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameDiagramEmbed } from '../src/web/editor/diagramTitleSource.ts';
import { parseEditorDiagrams } from '../src/web/editor/parseDiagrams.ts';

const definition = '\n\n[Схема]: ./Flow.mmd "Описание"\n';
const newTitle = 'Новая схема';

const cases = [
  { name: 'вики-вставка без подписи', source: '![[./Flow.mmd]]', text: '![[./Flow.mmd|Новая схема]]' },
  { name: 'прямая вставка', source: '![Схема](<./Flow.mmd> "Описание")', text: '![Новая схема](<./Flow.mmd> "Описание")' },
  { name: 'полная ссылка', source: `![Старое [имя]][Схема]${definition}`, text: '![Новая схема][Схема]' },
  { name: 'сокращённая ссылка', source: `![Схема][]${definition}`, text: '![Новая схема][Схема]' },
  { name: 'неявная ссылка', source: `![Схема]${definition}`, text: '![Новая схема][Схема]' }
] as const;

for (const item of cases) {
  test(`Переименование сохраняет ссылку на схему: ${item.name}`, () => {
    // Arrange: найти вставку в одной из поддерживаемых форм Markdown.
    const [diagram] = parseEditorDiagrams(item.source);
    assert.ok(diagram);

    // Act: изменить подпись вставки.
    const result = renameDiagramEmbed(item.source, diagram, newTitle);

    // Assert: новый фрагмент сохраняет путь или идентификатор определения.
    assert.deepEqual(result, { text: item.text });
  });
}

test('Подпись с вертикальной чертой не ломает вики-вставку', () => {
  // Arrange: вертикальная черта отделяет путь от подписи.
  const source = '![[./Flow.mmd|Схема]]';
  const [diagram] = parseEditorDiagrams(source);
  assert.ok(diagram);

  // Act: попытаться записать подпись с разделителем.
  const result = renameDiagramEmbed(source, diagram, 'Зона | Склад');

  // Assert: редактор получает сообщение вместо фрагмента для записи.
  assert.ok('error' in result);
});
