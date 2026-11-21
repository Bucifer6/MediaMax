/**
 * Kinora brand: new installs default to the Kinora theme, the brand themes pass WCAG AA, and the
 * shipped logo files are outlines only (no <text>, scripts or external references).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const branding = await import('../src/services/branding.ts');
const { BUILTIN_THEMES, DEFAULT_THEME_ID } = await import('../src/services/themes.ts');
const auth = await import('../src/services/auth.ts');

test('a new install defaults to the Kinora theme and keeps it once accounts exist', () => {
  assert.equal(DEFAULT_THEME_ID, 'mediamax');
  assert.equal(branding.getBranding().defaultThemeId, 'mediamax');
  auth.createUser({ username: 'admin', password: 'pass1234', isAdmin: true });
  assert.equal(branding.getBranding().defaultThemeId, 'mediamax');
  // White-label still works: an admin's choice wins.
  assert.equal(branding.updateBranding({ defaultThemeId: 'noir' }).defaultThemeId, 'noir');
});

test('Kinora themes use the brand colours and meet AA', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const cr = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  for (const id of ['mediamax', 'mediamax-light']) {
    const t = BUILTIN_THEMES.find((x) => x.id === id)!;
    assert.ok(t, id);
    const c = t.colors;
    for (const [a, b] of [[c.text, c.background], [c.text, c.surface], [c.textMuted, c.background], [c.textMuted, c.surface], [c.primaryText, c.primary]]) {
      assert.ok(cr(a, b) >= 4.5, `${id}: ${a} on ${b} = ${cr(a, b).toFixed(2)}`);
    }
    // accent is used for icons and large text: 3:1
    assert.ok(cr(c.accent, c.background) >= 3, `${id} accent`);
  }
});

test('shipped logo SVGs are pure outlines', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const files = [
    ...fs.readdirSync(path.join(repo, 'branding/kinora')).filter((f) => f.endsWith('.svg')).map((f) => `branding/kinora/${f}`),
    'web/public/favicon.svg',
  ];
  assert.ok(files.length > 20);
  for (const f of files) {
    const s = fs.readFileSync(path.join(repo, f), 'utf8');
    assert.doesNotMatch(s, /<text|<script|<image|href=|@import|url\((?!#)/i, f);
  }
});

test('the brand themes are named Kinora; their ids stay the same for existing settings', () => {
  assert.equal(BUILTIN_THEMES.find((t) => t.id === 'mediamax')?.name, 'Kinora');
  assert.equal(BUILTIN_THEMES.find((t) => t.id === 'mediamax-light')?.name, 'Kinora Light');
});

test('app identifiers come from one family, with kinora:// first and mediamax:// still registered', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const d = JSON.parse(fs.readFileSync(path.join(repo, 'apps/mobile/branding/defaults.json'), 'utf8'));
  assert.equal(d.bundleId, 'uk.burdujeni82.kinora');
  assert.equal(d.androidPackage, 'uk.burdujeni82.kinora');
  assert.equal(d.scheme, 'kinora');
  assert.deepEqual(d.legacySchemes, ['mediamax']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'tv/webos/appinfo.json'), 'utf8')).id, d.bundleId);
  assert.match(fs.readFileSync(path.join(repo, 'apps/roku/manifest'), 'utf8'), /^title=Kinora$/m);
});
