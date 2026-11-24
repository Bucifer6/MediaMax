import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, extractPalette, fitToTheme, mix, parseColor, tintFrom, type Palette, type Rgb, type ThemeTone } from '../src/theme/ambient.ts';
import { displayFont } from '../src/theme/applyTheme.ts';

/** 24×24 RGBA pixels: a block of each colour, in proportion to `weights`. */
function pixels(colors: Rgb[], weights: number[]): number[] {
  const out: number[] = [];
  const total = weights.reduce((a, b) => a + b, 0);
  colors.forEach((c, i) => {
    const n = Math.round((weights[i] / total) * 576);
    for (let k = 0; k < n; k++) out.push(c[0], c[1], c[2], 255);
  });
  return out;
}

test('extractPalette picks distinct, saturated colours first', () => {
  const p = extractPalette(pixels([[250, 40, 170], [20, 200, 240], [10, 10, 14], [128, 128, 128]], [3, 2, 6, 2]));
  assert.ok(p);
  const [a, b] = p;
  // Magenta and cyan beat the larger near-black and grey areas.
  assert.ok(a[0] > 200 && a[2] > 120, `first colour ${a}`);
  assert.ok(b[2] > 200 && b[1] > 150, `second colour ${b}`);
});

test('extractPalette handles flat and transparent images', () => {
  assert.equal(extractPalette(new Array(576 * 4).fill(0)), null);
  const flat = extractPalette(pixels([[90, 60, 30]], [1]));
  assert.ok(flat && flat.length === 3);
});

const dark: ThemeTone = { mode: 'dark', bg: parseColor('#0A0F22')!, text: parseColor('#F2F5FF')!, muted: parseColor('#9AA6CC')! };
const light: ThemeTone = { mode: 'light', bg: parseColor('#F5F7FF')!, text: parseColor('#0B1026')!, muted: parseColor('#4F5A7E')! };
const loud: Palette = [[255, 0, 0], [255, 255, 0], [255, 255, 255]];

test('fitToTheme keeps AA contrast for muted (and so body) text, dark and light', () => {
  for (const tone of [dark, light]) {
    for (const c of fitToTheme(loud, tone)) {
      assert.ok(contrast(c, tone.muted) >= 4.5, `${tone.mode}: muted contrast ${contrast(c, tone.muted).toFixed(2)} on ${c}`);
      assert.ok(contrast(c, tone.text) >= 4.5, `${tone.mode}: text contrast on ${c}`);
      // Any blend with the theme background (how the light is drawn) still passes.
      assert.ok(contrast(mix(c, tone.bg, 0.5), tone.muted) >= 4.5);
    }
  }
});

test('tintFrom returns a button colour with a readable label', () => {
  const t = tintFrom([[230, 60, 160], [40, 40, 40], [20, 200, 240]]);
  assert.ok(t);
  assert.ok(contrast(t.bg, t.fg) >= 4.5);
  // Greys make no tint.
  assert.equal(tintFrom([[120, 120, 120], [30, 30, 30], [200, 200, 200]]), null);
});

test('displayFont: Vibe display face (Outfit) for the Vibe / generic text faces, theme font otherwise', () => {
  assert.match(displayFont("'Figtree Variable', system-ui"), /Outfit/);
  assert.match(displayFont("'Inter', system-ui"), /Outfit/);
  assert.equal(displayFont("'Playfair Display', Georgia, serif"), "'Playfair Display', Georgia, serif");
});
