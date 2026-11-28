// Letterbox detection: black bars baked into the picture, ignoring dark scenes, overscan and lopsided frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBars, pictureStyle, settleBars, zoomForBars } from '../src/player/letterbox';

/** A w×h frame: `bar` black rows top and bottom, the rest mid-grey. */
function frame(w: number, h: number, topBar: number, bottomBar = topBar, fill = 128): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const black = y < topBar || y >= h - bottomBar;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      a[i] = a[i + 1] = a[i + 2] = black ? 8 : fill;
      a[i + 3] = 255;
    }
  }
  return a;
}

test('2.39:1 film in a 16:9 frame: bars found, zoom removes them', () => {
  // 64×36 sample; 2.39:1 content is 26.8 rows tall → ~4.6 rows of bar each side.
  const bar = detectBars(frame(64, 36, 5), 64, 36);
  assert.ok(Math.abs(bar - 5 / 36) < 1e-9);
  assert.equal(zoomForBars(bar), 1.34, 'capped');
  assert.equal(zoomForBars(0.1), 1.25);
});

test('no bars, thin edges, all-dark frames and lopsided frames', () => {
  assert.equal(detectBars(frame(64, 36, 0), 64, 36), 0);
  assert.equal(detectBars(frame(64, 36, 1), 64, 36), 0, 'overscan-sized edges ignored');
  assert.equal(detectBars(frame(64, 36, 0, 0, 5), 64, 36), 0, 'a fade to black is not a bar');
  assert.ok(Math.abs(detectBars(frame(64, 36, 6, 3), 64, 36) - 3 / 36) < 1e-9, 'the smaller side wins');
});

test('samples settle on the smallest bar; picture modes map to CSS', () => {
  assert.equal(settleBars([0.12, 0.2, 0.12]), 0.12);
  assert.equal(settleBars([0.12]), 0, 'needs a few samples');
  assert.deepEqual(pictureStyle('fill', 1), { objectFit: 'cover', scale: 1 });
  assert.deepEqual(pictureStyle('auto', 1.25, 21 / 9, 16 / 9), { objectFit: 'contain', scale: 1.25 }, 'a wide screen gains from removing the bars');
  assert.deepEqual(pictureStyle('auto', 1.3, 16 / 9, 16 / 9), { objectFit: 'contain', scale: 1 }, 'a 16:9 screen would only crop the sides');
  assert.deepEqual(pictureStyle('stretch', 1), { objectFit: 'fill', scale: 1 });
});
