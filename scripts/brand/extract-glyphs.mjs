#!/usr/bin/env node
/**
 * Extract the glyph outlines the MediaMax logo needs from Plus Jakarta Sans (SIL OFL 1.1) into
 * branding/mediamax/source/glyphs.json, so the logo can be rebuilt as plain SVG paths without the
 * font installed and without any runtime dependency.
 *
 * Only needed when changing the typeface or the text. Needs opentype.js (not a repo dependency):
 *
 *   npm i --no-save opentype.js@1.3.4
 *   node scripts/brand/extract-glyphs.mjs --800 PlusJakartaSans-ExtraBold.ttf --700 PlusJakartaSans-Bold.ttf
 *
 * The TTFs come from https://fonts.google.com/specimen/Plus+Jakarta+Sans (or github.com/tokotype/PlusJakartaSans).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const require = createRequire(path.join(process.cwd(), 'noop.js'));
const opentype = require('opentype.js');
const arg = (k) => process.argv[process.argv.indexOf(k) + 1];

const TEXT = { 800: 'MediaMax', 700: 'STREAM WITHOUT LIMITS.' };
const out = { font: 'Plus Jakarta Sans', licence: 'SIL Open Font License 1.1', weights: {} };
for (const w of [800, 700]) {
  const font = opentype.loadSync(arg(`--${w}`));
  const chars = [...new Set(TEXT[w])];
  const glyphs = {};
  for (const c of chars) {
    const g = font.charToGlyph(c);
    // Path at 1000 units/em with the baseline at y = 0 (y grows downwards, as in SVG).
    const scale = 1000 / font.unitsPerEm;
    glyphs[c] = { adv: +(g.advanceWidth * scale).toFixed(2), d: g.getPath(0, 0, 1000).toPathData(2) };
  }
  const kern = {};
  for (const a of chars) for (const b of chars) {
    const v = font.getKerningValue(font.charToGlyph(a), font.charToGlyph(b));
    if (v) kern[a + b] = +((v * 1000) / font.unitsPerEm).toFixed(2);
  }
  out.weights[w] = { capHeight: Math.round((font.tables.os2.sCapHeight * 1000) / font.unitsPerEm), xHeight: Math.round((font.tables.os2.sxHeight * 1000) / font.unitsPerEm), glyphs, kern };
}
const dest = path.join(repo, 'branding/mediamax/source/glyphs.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
console.log(`Wrote ${path.relative(repo, dest)}`);
