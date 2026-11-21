/**
 * App-review pack (scripts/review-pack): the fixtures the review server writes, the reviewer account policy, the
 * password checks, the pinned CC0 downloads and the compose file. Building the media itself needs ffmpeg, eSpeak NG
 * and Chromium and is not run here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fx = await import('../../scripts/review-pack/lib/fixtures.mjs');
const seed = await import('../../scripts/review-pack/seed-review-server.mjs');
const catalog = await import('../../scripts/review-pack/lib/catalog.mjs');
const { parseFeed } = await import('../src/services/podcasts.ts');
const { parseM3u } = await import('../src/services/livetv/m3u.ts');

test('podcast feed: Kinora parses the generated RSS, newest first, with absolute enclosure URLs', () => {
  const xml = fx.podcastFeed({
    base: 'http://fixtures/pack/podcast/',
    show: { slug: 'kinora-notes', title: 'Kinora Notes', author: 'Kinora Story Lab', description: 'Demo & test', language: 'en-gb' },
    episodes: [
      { n: 1, title: 'One', date: '2026-10-01T09:00:00Z', file: 'kinora-notes-01.mp3', bytes: 1000, seconds: 61 },
      { n: 2, title: 'Two <b>', date: '2026-10-08T09:00:00Z', file: 'kinora-notes-02.mp3', bytes: 2000, seconds: 3725 },
    ],
  });
  assert.match(xml, /<itunes:duration>01:02:05<\/itunes:duration>/);
  assert.match(xml, /Two &lt;b&gt;/);
  const feed = parseFeed(xml);
  assert.equal(feed.title, 'Kinora Notes');
  assert.equal(feed.episodes.length, 2);
  assert.equal(feed.episodes[0].title, 'Two <b>');
  assert.equal(feed.episodes[1].url, 'http://fixtures/pack/podcast/kinora-notes-01.mp3');
});

test('live TV playlist: Kinora parses the generated M3U (ids, numbers, groups, logos, HLS URLs)', () => {
  const m3u = fx.m3uPlaylist({ streamBase: 'http://fixtures/live/', logoBase: 'http://fixtures/pack/livetv/logos', guideUrl: 'http://fixtures/gen/guide.xml', channels: catalog.CHANNELS });
  const pl = parseM3u(m3u);
  assert.equal(pl.epgUrl, 'http://fixtures/gen/guide.xml');
  assert.equal(pl.entries.length, catalog.CHANNELS.length);
  assert.deepEqual(pl.entries.map((e: any) => [e.tvgId, e.chno, e.group, e.url]), catalog.CHANNELS.map((c: any) => [c.id, c.number, 'Kinora Test Channels', `http://fixtures/live/${c.id}/index.m3u8`]));
  assert.equal(pl.entries[0].logo, `http://fixtures/pack/livetv/logos/${catalog.CHANNELS[0].id}.png`);
});

test('guide: contiguous half-hour programmes around now for every channel', () => {
  const now = Date.UTC(2026, 10, 21, 14, 47, 0);
  const xml = fx.xmltvGuide({ channels: catalog.CHANNELS, now, days: 1, hoursBack: 2 });
  const progs = [...xml.matchAll(/<programme start="(\d{14}) \+0000" stop="(\d{14}) \+0000" channel="([^"]+)"/g)];
  assert.equal(progs.length, catalog.CHANNELS.length * (26 * 2));
  const first = progs.filter((p) => p[3] === catalog.CHANNELS[0].id);
  assert.equal(first[0][1], '20261121123000');
  for (let i = 1; i < first.length; i++) assert.equal(first[i][1], first[i - 1][2]);
  assert.ok(first.some((p) => p[1] <= '20261121144700' && p[2] > '20261121144700'), 'a programme is on now');
  assert.equal(fx.xmltvTime(Date.UTC(2026, 0, 2, 3, 4, 5)), '20260102030405 +0000');
});

test('reviewer account: never admin, may stream remotely, no DVR, not listed on the sign-in screen', () => {
  const p = seed.reviewerPolicy(true);
  assert.equal(p.isAdmin, false);
  assert.equal(p.allowRemote, true);
  assert.equal(p.allowDvr, false);
  assert.equal(p.showOnSignIn, false);
  assert.equal(p.disabled, false);
  assert.equal(p.allowLiveTv, true);
  assert.equal(seed.reviewerPolicy(false).allowLiveTv, false);
});

test('review passwords: placeholders and short passwords are refused', () => {
  assert.throws(() => seed.checkPassword(undefined, 'X'), /not set/);
  assert.throws(() => seed.checkPassword('short', 'X'), /12 characters/);
  assert.throws(() => seed.checkPassword('change-me-reviewer-password', 'X'), /placeholder/);
  assert.doesNotThrow(() => seed.checkPassword('Qv7-lantern-orbit-42', 'X'));
});

test('downloads.json: core files are CC0 with a pinned SHA-256 and a licence page; CC BY is optional only', () => {
  const d = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/review-pack/downloads.json'), 'utf8'));
  assert.ok(d.core.length >= 2);
  for (const f of d.core) {
    assert.equal(f.licence, 'CC0-1.0', f.id);
    assert.match(f.sha256, /^[0-9a-f]{64}$/, f.id);
    assert.match(f.page, /^https:\/\//, f.id);
    assert.match(f.dest, /^library\/Music\//, f.id);
  }
  for (const f of d.optional) assert.notEqual(f.licence, 'CC0-1.0');
  for (const f of d.optional) assert.ok(f.credit, `${f.id} needs an attribution line`);
});

test('review server compose: Kinora only on loopback, pack mounted read-only, no real passwords committed', () => {
  const compose = fs.readFileSync(path.join(repo, 'deploy/review/docker-compose.yml'), 'utf8');
  assert.match(compose, /"127\.0\.0\.1:\$\{KINORA_REVIEW_PORT:-\d+\}:8484"/);
  assert.match(compose, /\.\/library:\/media:ro/);
  assert.match(compose, /\.\/:\/pack:ro/);
  const env = fs.readFileSync(path.join(repo, 'deploy/review/env.example'), 'utf8');
  for (const k of ['REVIEW_ADMIN_PASSWORD', 'REVIEW_PASSWORD']) assert.match(env, new RegExp(`^${k}=change-me`, 'm'));
});
