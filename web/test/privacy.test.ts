import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { castUserAgent } from '../src/player/cast.ts';

// The TV apps (Samsung, LG, VIDAA) load this web app, so what it fetches by itself is what their store privacy
// answers describe: see docs/store/LISTING.md.

test('index.html opens no connection to a third-party host at load', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const external = [...html.matchAll(/<(?:link|script|img|iframe)\b[^>]*(?:href|src)="(https?:)?\/\/[^"]+"/gi)].map((m) => m[0]);
  assert.deepEqual(external, []);
});

test('Cast is offered in desktop/Android Chrome and Edge, never in TV browsers', () => {
  assert.equal(castUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'), true);
  assert.equal(castUserAgent('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'), true);
  assert.equal(castUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'), true);
  // LG webOS says Chrome in its user agent.
  assert.equal(castUserAgent('Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.128 Safari/537.36 WebAppManager'), false);
  assert.equal(castUserAgent('Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36'), false);
  assert.equal(castUserAgent('Mozilla/5.0 (Linux; VIDAA 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Safari/537.36 Hisense'), false);
  assert.equal(castUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), false);
});
