// Unit tests for the web player's own subtitle parsers (run: npm test -w web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMarkup, parseSrt, parseTimestamp, parseVtt, sniffTextFormat } from '../src/player/subtitles/text.ts';
import { CueIndex, subtitleClock } from '../src/player/subtitles/timing.ts';
import { assColor, assOpacity, assPosition, assTime, parseAss } from '../src/player/subtitles/ass.ts';
import { decodeEvent, decodeRle, parsePgs, readSegments } from '../src/player/subtitles/pgs.ts';
import { cueText } from '../src/player/subtitles/types.ts';
import { encodeRle, encodeSup, sampleBitmap } from './pgsEncode.ts';

/* --------------------------------- SRT --------------------------------- */

test('timestamps: SRT comma, WebVTT dot, short form, malformed', () => {
  assert.equal(parseTimestamp('00:01:02,345'), 62345);
  assert.equal(parseTimestamp('01:00:00.000'), 3600000);
  assert.equal(parseTimestamp('02:03.5'), 123500);
  assert.equal(parseTimestamp('1:02:03.04'), 3723040);
  assert.ok(Number.isNaN(parseTimestamp('abc')));
});

test('SRT: cues, tags, {\\an8}, <font color>, CRLF/BOM, bad blocks skipped', () => {
  const src = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Hello</i> <b>world</b>\r\nsecond line\r\n\r\n'
    + '2\r\n00:00:04,000 --> 00:00:05,000\r\n{\\an8}<font color="#ff0000">Top red</font>\r\n\r\n'
    + 'garbage block\r\n\r\n'
    + '3\r\n00:00:09,000 --> 00:00:08,000\r\nend before start\r\n\r\n'
    + '4\n00:00:06,000 --> 00:00:07,250 X1:10 X2:20\nAT &amp; T &lt;3\n';
  const { cues } = parseSrt(src);
  assert.equal(cues.length, 3);
  assert.deepEqual([cues[0].start, cues[0].end], [1000, 3500]);
  assert.equal(cueText(cues[0]), 'Hello world\nsecond line');
  assert.ok(cues[0].runs.find((r) => r.text === 'Hello')!.i);
  assert.ok(cues[0].runs.find((r) => r.text === 'world')!.b);
  assert.equal(cues[1].runs[0].color, '#ff0000');
  assert.equal(cues[1].vtt?.line, 0, '{\\an8} → top');
  assert.equal(cueText(cues[2]), 'AT & T <3');
  assert.equal(cues[2].end, 7250);
});

test('markup: nested tags restore styles, WebVTT classes and voices', () => {
  const { runs } = parseMarkup('<v.loud Bob><c.yellow.bg_blue>Hi <i>there</i></c> plain</v>');
  assert.equal(runs[0].voice, 'Bob');
  assert.equal(runs[0].color, '#ffff00');
  assert.equal(runs[0].background, '#0000ff');
  assert.deepEqual(runs[0].classes, ['loud', 'yellow', 'bg_blue']);
  assert.ok(runs[1].i && runs[1].color === '#ffff00');
  assert.equal(runs[2].text, ' plain');
  assert.equal(runs[2].color, undefined);
});

/* -------------------------------- WebVTT -------------------------------- */

test('WebVTT: header, NOTE, STYLE classes, cue settings, timestamp tags', () => {
  const src = `WEBVTT - demo

NOTE this is a comment

STYLE
::cue(.shout) { color: #ff8800; font-weight: bold }

intro
00:00.500 --> 00:02.000 line:-2 position:30%,line-left size:50% align:start
<c.shout>Loud</c> and <00:00:01.000>timed

00:00:03.000 --> 00:00:04.000 line:10%,end vertical:rl align:middle
Vertical

00:00:05.000 --> 00:00:06.000
&lt;tag&gt; &nbsp;x
`;
  const p = parseVtt(src);
  assert.equal(p.cues.length, 3);
  const [a, b, c] = p.cues;
  assert.equal(a.id, 'intro');
  assert.deepEqual([a.start, a.end], [500, 2000]);
  assert.deepEqual(a.vtt, { line: -2, snapToLines: true, position: 30, positionAlign: 'line-left', size: 50, align: 'start' });
  assert.equal(cueText(a), 'Loud and timed');
  assert.deepEqual(p.classStyles?.shout, { color: '#ff8800', b: true });
  assert.deepEqual(b.vtt, { line: 10, snapToLines: false, lineAlign: 'end', vertical: 'rl', align: 'center' });
  assert.equal(cueText(c), '<tag>  x');
  assert.equal(sniffTextFormat(src), 'vtt');
  assert.equal(sniffTextFormat('[Script Info]\nTitle: x'), 'ass');
  assert.equal(sniffTextFormat('1\n00:00:01,000 --> 00:00:02,000\nx'), 'srt');
});

/* -------------------------------- timing -------------------------------- */

test('cue index: overlapping and long cues, next change, delay clock', () => {
  const idx = new CueIndex([
    { start: 0, end: 100_000, id: 'long' },
    { start: 1000, end: 2000, id: 'a' },
    { start: 1500, end: 2500, id: 'b' },
    { start: 5000, end: 6000, id: 'c' },
  ]);
  assert.deepEqual(idx.at(1600).map((c) => c.id), ['long', 'a', 'b']);
  assert.deepEqual(idx.at(2000).map((c) => c.id), ['long', 'b'], 'end is exclusive');
  assert.deepEqual(idx.at(3000).map((c) => c.id), ['long']);
  assert.deepEqual(new CueIndex([{ start: 10, end: 20 }]).at(25), []);
  assert.equal(idx.nextChange(1600), 2000);
  assert.equal(idx.nextChange(3000), 5000);
  // +500 ms delay shows subtitles later: at media 1400 the subtitle clock reads 900.
  assert.equal(subtitleClock(1400, 500), 900);
  assert.deepEqual(idx.at(subtitleClock(1400, 500)).map((c) => c.id), ['long']);
});

/* ---------------------------------- ASS ---------------------------------- */

const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,20,20,40,1
Style: Sign,DejaVu Serif,48,&H0000FFFF,&H000000FF,&H00402000,&H00000000,0,-1,0,0,100,100,0,0,3,2,0,8,10,10,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.50,Default,,0,0,0,,Hello, {\\i1}world{\\i0}\\Nline two
Dialogue: 1,0:00:02.00,0:00:06.00,Sign,,0,0,0,,{\\pos(960,200)\\fad(500,1000)\\c&H0000FF&}Red sign
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\k50}Ka{\\k100}ra{\\kf30}oke
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,{\\move(100,100,500,300)\\an7}Moving
Dialogue: 0,0:00:13.00,0:00:14.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}
`;

test('ASS: colours, times, styles, override tags, karaoke, move/fade', () => {
  assert.deepEqual(assColor('&H00FF0000'), { color: '#0000ff', alpha: 1 });
  assert.equal(assColor('&H80FFFFFF').alpha.toFixed(2), '0.50');
  assert.equal(assTime('0:01:02.34'), 62340);
  const p = parseAss(ASS);
  assert.deepEqual(p.playRes, { x: 1920, y: 1080 });
  assert.equal(p.cues.length, 4, 'drawing-only event skipped');
  const def = p.styles.get('Default')!;
  assert.equal(def.size, 64);
  assert.ok(def.bold);
  assert.equal(def.back, 'rgba(0,0,0,0.498)');
  const sign = p.styles.get('Sign')!;
  assert.equal(sign.primary, '#ffff00');
  assert.equal(sign.borderStyle, 3);
  assert.equal(sign.an, 8);
  assert.ok(p.fonts.includes('DejaVu Serif'));

  const [hello, red, kara, move] = p.cues;
  assert.equal(cueText(hello), 'Hello, world\nline two', 'commas in text survive');
  assert.ok(hello.runs.find((r) => r.text === 'world')!.i);
  assert.ok(!hello.runs.find((r) => r.text === 'Hello, ')!.i);
  assert.equal(hello.ass!.marginV, 40, 'style margin when event margin is 0');
  assert.equal(red.ass!.layer, 1);
  assert.deepEqual(red.ass!.pos, { x: 960, y: 200 });
  assert.equal(red.runs[0].color, '#ff0000');
  assert.equal(assOpacity(red.ass!, 250, 4000), 0.5);
  assert.equal(assOpacity(red.ass!, 3500, 4000), 0.5);
  assert.equal(assOpacity(red.ass!, 2000, 4000), 1);
  assert.deepEqual(kara.runs.map((r) => [r.text, r.karaoke?.start, r.karaoke?.dur, r.karaoke?.kind]), [['Ka', 0, 500, 'k'], ['ra', 500, 1000, 'k'], ['oke', 1500, 300, 'kf']]);
  assert.equal(kara.runs[0].karaoke!.before, '#ff0000', 'secondary colour before the syllable is sung');
  assert.equal(move.ass!.an, 7);
  assert.deepEqual(assPosition(move.ass!, 1000, 2000), { x: 300, y: 200 });
});

test('SSA v4 styles: TertiaryColour and legacy alignment', () => {
  const ssa = `[Script Info]
ScriptType: v4.00

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding
Style: Default,Arial,20,16777215,65535,255,0,0,0,1,2,0,6,10,10,10,0,0

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:02.00,*Default,,0000,0000,0000,,Top centre
`;
  const p = parseAss(ssa);
  assert.equal(p.cues.length, 1);
  assert.equal(p.styles.get('Default')!.an, 8, 'SSA 6 = top centre');
  assert.equal(p.styles.get('Default')!.outlineColor, '#ff0000');
  assert.deepEqual(p.playRes, { x: 384, y: 288 });
});

/* ---------------------------------- PGS ---------------------------------- */

const palette = [{ index: 1, r: 30, g: 120, b: 230, a: 200 }, { index: 2, r: 255, g: 255, b: 255, a: 255 }, { index: 3, r: 255, g: 200, b: 0, a: 255 }];

test('PGS: RLE round trip incl. long runs', () => {
  const w = 300, h = 7;
  const px = sampleBitmap(w, h);
  px.fill(0, 0, 200); // a long transparent run
  px.fill(3, w * 3, w * 3 + 150); // a long coloured run
  assert.deepEqual(decodeRle(encodeRle(px, w, h), w, h), px);
});

test('PGS: segments, display sets, timing, colours, partial files, fragmented objects', () => {
  const big = { width: 1200, height: 300 }; // RLE > 64 KiB → several ODS fragments
  const sup = encodeSup([
    { startMs: 1000, endMs: 3000, bitmap: { x: 100, y: 700, width: 200, height: 40, pixels: sampleBitmap(200, 40) }, palette },
    { startMs: 5000, endMs: 7000, bitmap: { x: 300, y: 600, ...big, pixels: (() => { const p = new Uint8Array(big.width * big.height); for (let i = 0; i < p.length; i++) p[i] = (i * 7 + (i >> 5)) % 4; return p; })() }, palette },
  ]);
  const segs = readSegments(sup).segments;
  assert.ok(segs.filter((s) => s.type === 0x15).length >= 3, 'large object split over several ODS segments');
  const { events, consumed } = parsePgs(sup);
  assert.equal(consumed, sup.length);
  assert.equal(events.length, 2);
  assert.deepEqual([events[0].start, events[0].end], [1000, 3000], 'cleared by the next (empty) display set');
  assert.equal(events[0].videoWidth, 1920);
  const [bmp] = decodeEvent(events[0]);
  assert.deepEqual([bmp.x, bmp.y, bmp.width, bmp.height], [100, 700, 200, 40]);
  // Pixel (30,10) is fill colour 1: RGB ≈ (30,120,230), alpha 200 after the YCbCr round trip.
  const o = (10 * 200 + 30) * 4;
  const [r, g, b, a] = [bmp.rgba[o], bmp.rgba[o + 1], bmp.rgba[o + 2], bmp.rgba[o + 3]];
  assert.ok(Math.abs(r - 30) <= 3 && Math.abs(g - 120) <= 3 && Math.abs(b - 230) <= 3, `${r},${g},${b}`);
  assert.equal(a, 200);
  assert.equal(bmp.rgba[3], 255, 'outline pixel opaque');
  const [big1] = decodeEvent(events[1]);
  assert.equal(big1.rgba.length, big.width * big.height * 4);
  // Truncated download: stops at the last complete segment.
  const part = parsePgs(sup.subarray(0, Math.floor(sup.length * 0.4)));
  assert.ok(part.consumed < sup.length * 0.4 + 1);
  assert.ok(part.events.length <= 1);
});

test('PGS: our decoder matches ffmpeg\'s pgssub decoder', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgs-'));
  const w = 240, h = 60;
  const sup = encodeSup([{ startMs: 500, endMs: 4000, bitmap: { x: 40, y: 20, width: w, height: h, pixels: sampleBitmap(w, h) }, palette }], { width: 320, height: 240 });
  fs.writeFileSync(path.join(dir, 's.sup'), sup);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=3', '-i', path.join(dir, 's.sup'), '-filter_complex', '[0:v][1:s]overlay,format=rgb24', '-ss', '1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, r.stderr?.toString());
  const frame = r.stdout as Buffer;
  const [bmp] = decodeEvent(parsePgs(sup).events[0]);
  // Compare a stripe pixel and an outline pixel (opaque: overlay output = our colour). ffmpeg uses BT.601 for SD sizes too.
  for (const [x, y] of [[0, 0], [8, 2], [50, 30]]) {
    const o = (y * w + x) * 4;
    if (bmp.rgba[o + 3] !== 255) continue;
    const f = ((y + 20) * 320 + (x + 40)) * 3;
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(frame[f + c] - bmp.rgba[o + c]) <= 6, `pixel ${x},${y} channel ${c}: ffmpeg ${frame[f + c]} vs ours ${bmp.rgba[o + c]}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
