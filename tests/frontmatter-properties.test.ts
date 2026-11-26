import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readProperties, editProperty } from '../src/web/editor/frontmatterProperties';
import type { PropertyEdit } from '../src/web/editor/frontmatterProperties';

function edit(source: string, operation: PropertyEdit): string {
  const change = editProperty(readProperties(source), operation);
  assert.ok(change);
  return source.slice(0, change.from) + change.insert + source.slice(change.to);
}

test('reading properties keeps their types and leaves foreign YAML read-only', () => {
  const parsed = readProperties('---\ntitle: "123"\ncount: 12\nreviewed: false\ntags: [api, import]\naliases: [other]\nowner: &owner Ann\nref: *owner\n---\n# Heading\n');
  assert.equal(parsed.kind, 'valid');
  assert.deepEqual(parsed.rows.map(row => [row.name, row.value]), [
    ['title', '123'], ['count', 12], ['reviewed', false], ['tags', ['api', 'import']],
    ['aliases', { yaml: '[other]' }], ['owner', { yaml: '&owner Ann' }], ['ref', { yaml: '*owner' }],
  ]);
});

test('adding a property keeps the BOM, CRLF and Markdown body', () => {
  const body = '# Heading\r\n\r\n#api\r\n';
  assert.equal(edit('\uFEFF' + body, { kind: 'add', name: 'title', value: 'true' }),
    '\uFEFF---\r\ntitle: "true"\r\n---\r\n\r\n' + body);
});

test('adding to an existing map preserves its indentation and any leading comments', () => {
  const input = '---\n# Heading comment\n  title: Note\n---\nBody\n';
  const next = edit(input, { kind: 'add', name: 'reviewed', value: true });
  assert.equal(next, '---\n# Heading comment\n  title: Note\n  reviewed: true\n---\nBody\n');
  assert.equal(readProperties(next).rows[1]?.value, true);
  const empty = '---\n# Heading comment\n---\nBody\n';
  assert.equal(edit(empty, { kind: 'add', name: 'count', value: 3 }),
    '---\n# Heading comment\ncount: 3\n---\nBody\n');
});

test('editing and renaming patch just the target tokens', () => {
  const input = '---\n# Useful\n"title": \'Old\' # keep\naliases: [ alias ]\nother: { x: 1 }\n---\n\nBody  \n';
  const next = edit(input, { kind: 'set', name: 'title', value: 'New' });
  assert.equal(next, input.replace("'Old'", '"New"'));
  assert.equal(edit(next, { kind: 'rename', name: 'title', next: 'new:key' }), next.replace('"title"', '"new:key"'));
});

test('changing block values and deleting a field do not absorb subsequent comments', () => {
  const source = '---\ntags:\n  - api\n  - old\n# next field\nreviewed: false\n---\n\n# Body\n';
  const changed = edit(source, { kind: 'set', name: 'tags', value: ['api'] });
  assert.deepEqual(readProperties(changed).rows[0]?.value, ['api']);
  assert.match(changed, /\n# next field\nreviewed: false\n---\n\n# Body\n$/);
  assert.equal(edit(source, { kind: 'remove', name: 'tags' }), '---\n# next field\nreviewed: false\n---\n\n# Body\n');
});

test('editing an unindented tag sequence leaves valid YAML and keeps the key comment', () => {
  const source = '---\ntags: # Labels\n- api\n- old\nnext: true\n---\n';
  const changed = edit(source, { kind: 'set', name: 'tags', value: ['api'] });
  assert.equal(changed, '---\ntags: # Labels\n  ["api"]\nnext: true\n---\n');
  assert.deepEqual(readProperties(changed).rows.map(row => row.value), [['api'], true]);
});

test('unsafe or ambiguous frontmatter does not offer writes or get coerced', () => {
  for (const text of ['bad: [', 'a: 1\na: 2', 'not a map']) {
    const parsed = readProperties(`---\n${text}\n---\nBody`);
    assert.equal(parsed.kind, 'invalid');
    assert.equal(editProperty(parsed, { kind: 'add', name: 'x', value: 1 }), null);
  }
  assert.equal(readProperties('---\n\n# Thematic break').kind, 'missing');
  assert.equal(readProperties('---\na: 1').kind, 'invalid');
  for (const source of ['---\n{one: 1, two: true}\n---\n', '---\nowner: &x Joe\nalias: *x\n---\n']) {
    const parsed = readProperties(source);
    assert.equal(parsed.kind, 'valid');
    assert.equal(editProperty(parsed, { kind: 'remove', name: parsed.rows[0]?.name ?? '' }), null);
  }
  const normal = readProperties('---\ntitle: Hello\ntags: [api]\n---\n');
  assert.equal(editProperty(normal, { kind: 'rename', name: 'tags', next: 'labels' }), null);
  assert.equal(editProperty(normal, { kind: 'rename', name: 'title', next: 'tags' }), null);
});
