// WebVTT overlay helpers (src/player/vtt.ts; run: npm test in apps/mobile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCues, parseVtt } from '../src/player/vtt.ts';

test('a long cue stays active while many shorter cues start after it', () => {
  // One cue for 0–100 s (e.g. a sign / song lyric) and 50 one-second dialogue cues starting after it.
  const cues = [{ start: 0, end: 100_000, text: 'LONG' }];
  for (let k = 0; k < 50; k++) cues.push({ start: 1000 + k * 1500, end: 2000 + k * 1500, text: `d${k}` });
  cues.sort((a, b) => a.start - b.start);
  const at = (ms) => activeCues(cues, ms).map((c) => c.text);
  assert.deepEqual(at(500), ['LONG']);
  assert.deepEqual(at(1000 + 40 * 1500 + 10), ['LONG', 'd40'], '>20 later cues: the long one is still shown');
  assert.deepEqual(at(99_000), ['LONG']);
  assert.deepEqual(at(100_000), [], 'end is exclusive');
  assert.deepEqual(at(-1), []);
});

test('ordinary cues and parsing', () => {
  const cues = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<i>Hello</i> &amp; bye\n\n00:00:01.500 --> 00:00:03.000\nOverlap\n\n1\n00:00:05.000 --> 00:00:06.000 line:0\nLater\n');
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [[1000, 2000, 'Hello & bye'], [1500, 3000, 'Overlap'], [5000, 6000, 'Later']]);
  assert.deepEqual(activeCues(cues, 1700).map((c) => c.text), ['Hello & bye', 'Overlap']);
  assert.deepEqual(activeCues(cues, 2500).map((c) => c.text), ['Overlap']);
  assert.deepEqual(activeCues(cues, 4000), []);
  assert.deepEqual(activeCues(cues, 5500).map((c) => c.text), ['Later']);
  assert.deepEqual(activeCues([], 1000), []);
});
