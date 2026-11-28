// The viewer's subtitle preferences applied before drawing: SDH stripped, AutoSync maps applied, styling kept
// where the text didn't change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareText, prepareTimed } from '../src/player/subtitles/prepare';
import { parseSrt } from '../src/player/subtitles/text';

const SRT = `1
00:00:01,000 --> 00:00:02,000
[DOOR SLAMS]

2
00:00:03,000 --> 00:00:04,000
<i>JOHN: Where were you?</i>

3
00:00:05,000 --> 00:00:06,000
<b>Fine</b> thanks
`;

test('SDH cues are dropped or cleaned, untouched cues keep their styling', () => {
  const parsed = parseSrt(SRT);
  const out = prepareText(parsed, { stripSdh: true });
  assert.equal(out.cues.length, 2);
  assert.deepEqual(out.cues[0].runs, [{ text: 'Where were you?', i: true }]);
  assert.equal(out.cues[1], parsed.cues[2], 'unchanged cue object is reused');
});

test('AutoSync map moves every cue (and bitmap events)', () => {
  const parsed = parseSrt(SRT);
  const map = { ratio: 1, offsetMs: -500, groups: [{ fromMs: 4000, offsetMs: 250 }] };
  const out = prepareText(parsed, { syncMap: map });
  assert.deepEqual(out.cues.map((c) => [c.start, c.end]), [[500, 1500], [2500, 3500], [4750, 5750]]);
  assert.deepEqual(prepareTimed([{ start: 10000, end: 12000 }], map), [{ start: 9750, end: 11750 }]);
  assert.equal(prepareText(parsed, {}), parsed, 'nothing to do → same object');
});
