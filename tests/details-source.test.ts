import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailsBody, detailsRanges } from '../src/web/editor/detailsSource';

test('details offsets preserve CRLF and ignore closing tags inside fenced code', () => {
  const opening = '<details open>\r\n<summary>Схема 🚀</summary>\r\n';
  const body = '\r\n```html\r\n</details>\r\n```\r\n';
  const block = opening + body + '</details>\r';
  const before = '# До\r\n\r\n';
  const source = `${before}${block}\nСнаружи`;
  assert.deepEqual(detailsRanges(source), [{
    from: before.length,
    to: before.length + block.length,
    bodyFrom: before.length + opening.length,
    bodyTo: before.length + opening.length + body.length,
    bodyIndent: 0,
    summary: 'Схема 🚀',
    summaryRange: {
      from: before.length + opening.indexOf('Схема'),
      to: before.length + opening.indexOf('</summary>'),
    },
    open: true,
  }]);
});

test('multiline summaries keep the body intact and collapse whitespace in the label', () => {
  for (const eol of ['\n', '\r\n']) {
    const header = ['<details open>', '  <summary>', '    Some', '    text', '  </summary>', ''].join(eol);
    const body = `  content${eol}`;
    const source = `${header}${body}</details>${eol}After`;
    const [block] = detailsRanges(source);
    assert.ok(block);
    assert.equal(block.summary, 'Some text');
    assert.equal(block.open, true);
    assert.equal(source.slice(block.bodyFrom, block.bodyTo), body);
  }
});

test('an unclosed summary cannot consume the next details block', () => {
  const before = '<details>\n  <summary>\n    Незакрытый заголовок\n</details>\n\n';
  const next = '<details>\n  <summary>\n    Следующий блок\n  </summary>\n  Текст\n</details>';
  const ranges = detailsRanges(before + next);
  assert.equal(ranges.find(block => block.summary === 'Следующий блок')?.from, before.length);
});

test('details do not claim tags inside code or an unclosed block', () => {
  const tags = '<details><summary>Текст</summary>\n\nСодержимое\n';
  assert.deepEqual(detailsRanges(`\`\`\`html\n${tags}</details>\n\`\`\``), []);
  assert.deepEqual(detailsRanges(`${tags}\nОстальная заметка`), []);
});

test('nested tags with unsupported attributes do not close the outer block', () => {
  const inner = '<details class="import">\n<summary>Внутренний</summary>\n\nТекст\n\n</details>';
  const outer = `<details><summary>Внешний</summary>\n\n${inner}\n\nВсё ещё внутри.\n\n</details>`;
  assert.equal(detailsRanges(`${outer}\n\nСнаружи`)[0]?.to, outer.length);
});

test('details inside a list item keep the original source ranges', () => {
  for (const indent of ['   ', '    ']) {
    const before = `${indent.length === 3 ? '1.' : '10.'} Обновление БД\n\n`;
    const opening = `${indent}<details><summary>Маппинг</summary>\n`;
    const body = `\n${indent}| Колонка |\n${indent}| --- |\n${indent}| interest_id |\n\n`;
    const block = opening + body + `${indent}</details>`;
    const source = `${before}${block}\n\nПосле списка.`;
    assert.deepEqual(detailsRanges(source).map(range => ({
      block: source.slice(range.from, range.to),
      body: source.slice(range.bodyFrom, range.bodyTo),
      summary: range.summary,
    })), [{ block, body, summary: 'Маппинг' }]);
  }
});

test('details markers inside indented code or HTML comments are not accordions', () => {
  const lines = ['<details>', '<summary>Пример</summary>', 'Текст', '</details>'];
  assert.deepEqual(detailsRanges(lines.map(line => `    ${line}`).join('\n')), []);
  assert.deepEqual(detailsRanges(`<!--\n${lines.join('\n')}\n-->`), []);
});

test('details preview removes only the list prefix, preserving code indentation', () => {
  const source = '10. Пункт\n\n      <details>\n      <summary>Пример</summary>\n\n' +
    '    Пояснение\n\n        SELECT 1;\n\n      </details>';
  const [block] = detailsRanges(source);
  assert.ok(block);
  assert.equal(detailsBody(source.slice(block.bodyFrom, block.bodyTo), block.bodyIndent),
    '\nПояснение\n\n    SELECT 1;\n\n');
});

test('spoiler ranges follow tag pairs without depending on line breaks', () => {
  const cases = [
    { header: '<details><summary>Some</summary>', body: 'content', close: '</details>', open: false },
    { header: '<DETAILS\n data-label="open > here" OPEN=""><SUMMARY class="label" >Some</SUMMARY >', body: ' content\n', close: '</DETAILS >', open: true },
    { header: '<details>\n<summary>Some</summary> ', body: ' content ', close: '</details>', open: false },
  ];
  for (const { header, body, close, open } of cases) {
    const block = `${header}${body}${close}`;
    const source = `Before ${block} After`;
    const [range] = detailsRanges(source);
    assert.ok(range, header);
    assert.equal(source.slice(range.from, range.to), block);
    assert.equal(source.slice(range.bodyFrom, range.bodyTo).trim(), body.trim());
    assert.deepEqual([range.summary, range.open], ['Some', open]);
    assert.ok(range.summaryRange);
    assert.equal(source.slice(range.summaryRange.from, range.summaryRange.to), 'Some');
  }
});

test('an unfinished opening leaves subsequent complete spoilers available', () => {
  const valid = '<details><summary>Рабочий</summary>Текст</details>';
  const source = `<details><summary>Черновик</summary>\n\n${valid}`;
  assert.deepEqual(detailsRanges(source).map(range => source.slice(range.from, range.to)), [valid]);
});

test('inline nesting does not consume siblings or literal code', () => {
  const inner = '<details><summary>Inner</summary>text</details>';
  const nested = `<details><summary>Outer</summary>${inner}</details>`;
  const sibling = '<details title="open"><summary>Sibling</summary>other</details>';
  const source = `\`${inner}\` <!-- ${inner} --> ${nested}${sibling}`;
  const ranges = detailsRanges(source);
  assert.deepEqual(ranges.map(range => source.slice(range.from, range.to)), [nested, sibling]);
  assert.equal(ranges[1]?.open, false);
  const [outer] = ranges;
  assert.ok(outer);
  assert.equal(source.slice(outer.bodyFrom, outer.bodyTo), inner);
});

test('escaped markup stays literal; an even number of backslashes does not escape a tag', () => {
  const spoiler = '<details><summary>Title</summary>Body</details>';
  assert.deepEqual(detailsRanges(`\\${spoiler}`), []);
  assert.deepEqual(detailsRanges(`\\\\${spoiler}`).map(range => range.from), [2]);
});

test('a missing or empty summary does not consume body text', () => {
  const cases = [
    ['<details>Body</details>', 'Body'],
    ['<details>Lead <summary>Not the heading</summary>Body</details>', 'Lead <summary>Not the heading</summary>Body'],
    ['<details></summary>Body</details>', '</summary>Body'],
    ['<details><summary>  </summary>Body</details>', 'Body'],
  ] as const;
  for (const [source, body] of cases) {
    const [range] = detailsRanges(source);
    assert.ok(range, source);
    assert.equal(range.summary, 'Подробности');
    assert.equal(source.slice(range.bodyFrom, range.bodyTo), body);
  }
});

test('a misplaced or missing summary end does not turn invalid markup into a spoiler', () => {
  assert.deepEqual(detailsRanges('<details><summary>Draft<summary>Other</details>'), []);
  assert.deepEqual(detailsRanges('<details><summary>Draft</details>'), []);
  assert.deepEqual(detailsRanges('<details><summary>Draft'), []);
  assert.deepEqual(detailsRanges('Text\n\n<details>'), []);
});

test('a list marker without inline content still contributes its indentation', () => {
  const source = 'Before\n\n10.\n\n    <details>Body\n    more\n    </details>';
  const [range] = detailsRanges(source);
  assert.ok(range);
  assert.equal(detailsBody(source.slice(range.bodyFrom, range.bodyTo), range.bodyIndent), 'Body\nmore\n');
});

test('a spoiler in a list after a paragraph keeps its code indentation', () => {
  const source = 'Intro\n\n1. Item\n\n   <details>\n   Text\n\n       code\n   </details>';
  const [range] = detailsRanges(source);
  assert.ok(range);
  assert.equal(detailsBody(source.slice(range.bodyFrom, range.bodyTo), range.bodyIndent), 'Text\n\n    code\n');
});

test('an opening tag at the start of indented code cannot pair with an outside closing tag', () => {
  assert.deepEqual(detailsRanges('    <details>\n\nText\n</details>'), []);
});
