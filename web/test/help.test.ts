// Help Centre: the safe Markdown subset parser and the "Why" reason → article map (run: npm test -w web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { headingId, inlineText, isSafeHref, parseInline, parseMarkdown, type Block } from '../src/utils/markdown.ts';
import { helpForReason, helpPath } from '../src/utils/helpLinks.ts';

test('inline: bold, italic, code, kbd, links and escapes', () => {
  assert.deepEqual(parseInline('a **b** *c* `d` <kbd>G</kbd>'), [
    { t: 'text', v: 'a ' }, { t: 'strong', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' ' }, { t: 'em', c: [{ t: 'text', v: 'c' }] },
    { t: 'text', v: ' ' }, { t: 'code', v: 'd' }, { t: 'text', v: ' ' }, { t: 'kbd', v: 'G' },
  ]);
  assert.deepEqual(parseInline('[Help](help:subtitles#timing)'), [{ t: 'link', href: 'help:subtitles#timing', c: [{ t: 'text', v: 'Help' }] }]);
  assert.deepEqual(parseInline('\\*not italic\\*'), [{ t: 'text', v: '*not italic*' }]);
  assert.deepEqual(parseInline('<kbd>&lt;</kbd>'), [{ t: 'kbd', v: '<' }]);
  assert.equal(inlineText(parseInline('**Settings → Playback**')), 'Settings → Playback');
});

test('inline: raw HTML stays text and unsafe links lose their href', () => {
  const nodes = parseInline('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](//evil.example) [z](data:text/html,hi)');
  assert.ok(nodes.every((n) => n.t === 'text'), JSON.stringify(nodes));
  assert.ok(inlineText(nodes).includes('<img src=x onerror=alert(1)>'));
  assert.ok(isSafeHref('https://example.com/a'));
  assert.ok(isSafeHref('/settings/playback'));
  assert.ok(isSafeHref('help:why-transcoding#bitrate'));
  assert.ok(isSafeHref('mailto:a@b.c'));
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:x', '//evil.example', 'data:text/html,x', 'vbscript:x', 'help:../x']) assert.ok(!isSafeHref(bad), bad);
});

test('blocks: headings with ids, lists, tables, code and quotes', () => {
  const md = [
    '## Video codec not supported {#video-codec}',
    '',
    'Text one',
    'continues.',
    '',
    '1. First',
    '2. Second',
    '   - nested',
    '',
    '| Key | Action |',
    '|---|:---:|',
    '| <kbd>G</kbd> | Earlier \\| sooner |',
    '',
    '```',
    'docker run x',
    '```',
    '> **Tip:** quoted',
    '### Two & three',
  ].join('\n');
  const b = parseMarkdown(md);
  const types = b.map((x) => x.t);
  assert.deepEqual(types, ['heading', 'p', 'list', 'table', 'code', 'quote', 'heading']);
  assert.equal((b[0] as Extract<Block, { t: 'heading' }>).id, 'video-codec');
  assert.equal(inlineText((b[1] as Extract<Block, { t: 'p' }>).c), 'Text one continues.');
  const list = b[2] as Extract<Block, { t: 'list' }>;
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[1].children[0].t, 'list');
  const table = b[3] as Extract<Block, { t: 'table' }>;
  assert.deepEqual(table.align, [null, 'center']);
  assert.equal(inlineText(table.rows[0][1]), 'Earlier | sooner');
  assert.equal((b[4] as Extract<Block, { t: 'code' }>).v, 'docker run x');
  assert.equal((b[6] as Extract<Block, { t: 'heading' }>).id, 'two-three');
});

test('heading ids match the server rules', () => {
  assert.equal(headingId('Direct play, remux and transcode'), 'direct-play-remux-and-transcode');
  assert.equal(headingId('`Café` *crème*'), 'cafe-creme');
});

test('every shipped article parses without dropping text', () => {
  const root = path.resolve(import.meta.dirname, '../../server/help');
  const files: string[] = [];
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.md') && files.push(path.join(d, e.name))));
  walk(root);
  assert.ok(files.length >= 35);
  for (const f of files) {
    const body = fs.readFileSync(f, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
    const blocks = parseMarkdown(body);
    assert.ok(blocks.length > 0, f);
    const dump = JSON.stringify(blocks);
    // Every help: link survived as a link node (none were unsafe or mis-parsed).
    const links = body.match(/\]\(help:[^)]+\)/g) ?? [];
    assert.equal((dump.match(/"href":"help:/g) ?? []).length, links.length, `${path.basename(f)}: help links`);
  }
});

test('reason → troubleshooting anchor', () => {
  const cases: [string, string][] = [
    ['video codec hevc not supported', 'video-codec'],
    ['10-bit hevc not supported', 'ten-bit'],
    ['resolution exceeds 1080p', 'resolution'],
    ['resolution exceeds 1920', 'resolution'],
    ['HDR10 needs tone-mapping for this SDR device', 'hdr-tone-mapping'],
    ['HLG needs tone-mapping for this device', 'hdr-tone-mapping'],
    ['Dolby Vision profile 5 has no HDR10 fallback layer; tone-mapping', 'hdr-tone-mapping'],
    ['Dolby Vision profile 7 (dual-layer) remuxed to its HDR10 base layer', 'dolby-vision-dual-layer'],
    ["Dolby Vision 8 can't be remuxed with its Dolby Vision signalling by this FFmpeg", 'dolby-vision-ffmpeg'],
    ['audio codec dts not supported', 'audio-format'],
    ["TrueHD Atmos → E-AC-3 5.1: device can't play TrueHD", 'audio-format'],
    ['DTS-HD MA → DTS core: device plays DTS but not DTS-HD', 'audio-format'],
    ['E-AC-3 5.1 → AAC Stereo: audio processing requested', 'audio-processing'],
    ['container mkv not supported', 'container'],
    ['bitrate 45000k exceeds 8000k', 'bitrate'],
    ['non-default audio track selected', 'audio-track'],
    ['transcoding not permitted', 'transcoding-not-permitted'],
    ['something new', 'methods'],
  ];
  for (const [reason, anchor] of cases) assert.equal(helpForReason(reason), `why-transcoding#${anchor}`, reason);
  assert.equal(helpPath('why-transcoding#bitrate'), '/help/why-transcoding#bitrate');
  assert.equal(helpPath('subtitles'), '/help/subtitles');
});
