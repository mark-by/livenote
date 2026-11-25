import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkSpans } from '../src/server/vaultLinks.ts';

const key = (spans: Array<{ start: number; end: number; fullStart: number; fullEnd: number; target: string | null }>) =>
  spans.map(span => `${span.start}-${span.end}-${span.fullStart}-${span.fullEnd}-${span.target}`).join('|');

const repeatedLabel = '[read][file]\n\n[file]: first.md\n[file]: second.md\n';

test('vaultLinks keeps the first definition when a reference label is defined twice', () => {
  // Act: разбираем документ с двумя определениями одной метки.
  const spans = linkSpans(repeatedLabel);
  // Assert: CommonMark связывает употребление с первым определением.
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.target, 'first.md');
});

test('vaultLinks keeps the first definition for BOM and bodyStart offsets', () => {
  // Arrange: BOM перед повторяющимися определениями.
  const source = '\uFEFF' + repeatedLabel;
  // Act: разбираем с телом после BOM.
  const spans = linkSpans(source, 1);
  // Assert: цель остаётся первой, диапазоны смещены на BOM.
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.target, 'first.md');
  assert.equal(source.slice(spans[0]!.fullStart, spans[0]!.fullEnd), '[file]: first.md');
});

test('vaultLinks excluded range scan preserves link positions and counts', () => {
  // Arrange: исключения — экранирование, inline-код, ограждённый блок — и валидные ссылки.
  const cases: Array<[string, string]> = [
    ['\\[[escaped]] [[kept]]', '15-19-13-21-kept'],
    ['`[[hidden]]` [[kept]]', '15-19-13-21-kept'],
    ['```\n[[hidden]]\n```\n\n[[kept]]\n', '22-26-20-28-kept'],
    ['a `[[c1]]` b\n\n```\n[[c2]]\n```\n\n[[k1]] \\[[k2esc]] [[k3]]', '32-34-30-36-k1|50-52-48-54-k3'],
  ];
  for (const [source, expected] of cases) {
    // Act: извлекаем ссылки вокруг исключённых диапазонов.
    const spans = linkSpans(source);
    // Assert: позиции и число ссылок совпадают с прежним поведением.
    assert.equal(key(spans), expected, source);
  }
});

test('vaultLinks linear scan keeps one link per wiki target after many code blocks', () => {
  // Arrange: 2000 ограждённых блоков перед 2000 wiki-ссылками.
  const parts: string[] = [];
  for (let i = 0; i < 2000; i++) parts.push('```\n[[hidden' + i + ']]\n```');
  for (let i = 0; i < 2000; i++) parts.push('[[page' + i + ']]');
  const source = parts.join('\n\n') + '\n';
  // Act: извлекаем ссылки из большого документа.
  const spans = linkSpans(source);
  // Assert: скрытые цели не попали в результат, порядок и число сохранены.
  assert.equal(spans.length, 2000);
  assert.deepEqual(spans.slice(0, 2).map(span => span.target), ['page0', 'page1']);
  assert.deepEqual(spans.slice(-2).map(span => span.target), ['page1998', 'page1999']);
  assert.equal(key(spans.slice(0, 2)), '46892-46897-46890-46899-page0|46903-46908-46901-46910-page1');
  assert.equal(key(spans.slice(-2)), '73754-73762-73752-73764-page1998|73768-73776-73766-73778-page1999');
});
