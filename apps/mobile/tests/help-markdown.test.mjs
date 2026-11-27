// Help Centre Markdown subset (run: npm test in apps/mobile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpSlugOf, parseHelpMarkdown, parseInline } from '../src/utils/helpMarkdown.ts';

test('inline: bold, italic, code, kbd, links; placeholders like <folder> stay', () => {
  assert.deepEqual(parseInline('Press <kbd>OK</kbd> then **Play** in *Settings*, see [buffering](help:buffering) in C:\<folder>'), [
    { kind: 'text', text: 'Press ' },
    { kind: 'code', text: 'OK' },
    { kind: 'text', text: ' then ' },
    { kind: 'text', text: 'Play', bold: true },
    { kind: 'text', text: ' in ' },
    { kind: 'text', text: 'Settings', italic: true },
    { kind: 'text', text: ', see ' },
    { kind: 'link', text: 'buffering', href: 'help:buffering' },
    { kind: 'text', text: ' in C:\<folder>' },
  ]);
});

test('blocks: title skipped, headings with ids, joined paragraphs, lists, tables, code, quotes', () => {
  const md = ['# Title', '', '## Getting started', 'First line', 'second line.', '', '- one', '2. two', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '```', 'x = 1', '```', '> Note'].join('\n');
  const b = parseHelpMarkdown(md);
  assert.deepEqual(b.map((x) => x.type), ['heading', 'paragraph', 'item', 'item', 'table', 'code', 'quote']);
  assert.equal(b[0].id, 'getting-started');
  assert.deepEqual(b[1].spans, [{ kind: 'text', text: 'First line second line.' }]);
  assert.equal(b[3].ordered, true);
  assert.equal(b[4].rows.length, 1);
  assert.equal(b[5].text, 'x = 1');
});

test('help links', () => {
  assert.equal(helpSlugOf('help:no-sound'), 'no-sound');
  assert.equal(helpSlugOf('/help/buffering#tips'), 'buffering');
  assert.equal(helpSlugOf('https://example.com'), null);
});
