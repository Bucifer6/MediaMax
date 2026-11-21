// Home rows: "Random spotlight" rows from chosen libraries, and admin-pinned titles in the Top 10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HomeRowConfig } from '@mediamax/shared';

const { db } = await import('../src/db.ts');
const { createUser, getUser } = await import('../src/services/auth.ts');
const { buildHome, spotlightItems } = await import('../src/services/items.ts');
const { top10Items, clearRecommendationCache } = await import('../src/services/recommend.ts');
const { updateBranding } = await import('../src/services/branding.ts');

const now = new Date().toISOString();
const lib = (id: string, type: string) => db.insert('libraries', { id, name: id, type, paths: '[]', created_at: now });
const item = (id: string, library: string, type: string, cr: string | null = null) =>
  db.insert('items', { id, library_id: library, type, title: id, sort_title: id, content_rating: cr, added_at: now, updated_at: now });
const play = (userId: string, itemId: string) =>
  db.run('INSERT INTO play_history (user_id, item_id, started_at, duration_ms) VALUES (?, ?, ?, ?)', userId, itemId, now, 30 * 60_000);

lib('hr-movies', 'movies');
lib('hr-kids', 'movies');
lib('hr-shows', 'shows');
lib('hr-secret', 'movies');
for (let i = 1; i <= 12; i++) item(`mov${i}`, 'hr-movies', 'movie', i === 1 ? 'R' : 'PG');
for (let i = 1; i <= 5; i++) item(`kid${i}`, 'hr-kids', 'movie', 'G');
for (let i = 1; i <= 4; i++) item(`show${i}`, 'hr-shows', 'show', 'TV-PG');
item('sec1', 'hr-secret', 'movie', 'PG');
item('ep-x', 'hr-shows', 'episode');

const admin = getUser(createUser({ username: 'hr-admin', password: 'pass1234', isAdmin: true }).id);
// A restricted viewer: no access to hr-secret, rating limit PG-13 (so R is hidden).
const viewer = getUser(createUser({ username: 'hr-viewer', password: 'pass1234', libraryIds: ['hr-movies', 'hr-kids', 'hr-shows'], maxContentRating: 'PG-13' }).id);

test('spotlight: only the chosen libraries and item types', () => {
  const kids = spotlightItems(admin, { id: 'k', libraryIds: ['hr-kids'] }, 20);
  assert.equal(kids.length, 5);
  assert.ok(kids.every((i) => i.libraryId === 'hr-kids'));
  const series = spotlightItems(admin, { id: 's', itemTypes: ['show'] }, 20);
  assert.deepEqual(series.map((i) => i.type).filter((t) => t !== 'show'), []);
  assert.equal(series.length, 4, 'episodes and seasons are never picked');
  const mixed = spotlightItems(admin, { id: 'm', libraryIds: ['hr-movies', 'hr-shows'] }, 100);
  assert.equal(mixed.length, 16);
  assert.equal(spotlightItems(admin, { id: 'c', libraryIds: ['hr-movies'] }, 3).length, 3, 'count');
});

test('spotlight respects library access and parental ratings', () => {
  const all = spotlightItems(viewer, { id: 'v' }, 100).map((i) => i.id);
  assert.ok(!all.includes('sec1'), 'no library access → never picked');
  assert.ok(!all.includes('mov1'), 'over the rating limit → never picked');
  assert.equal(all.length, 11 + 5 + 4);
  // Choosing only a library the viewer can't see yields nothing (and the row is left out).
  assert.deepEqual(spotlightItems(viewer, { id: 'v2', libraryIds: ['hr-secret'] }, 10), []);
});

test('spotlight rotation: daily keeps the same picks all day, changes the next day and per row', () => {
  const day1 = new Date(2026, 10, 21, 9);
  const later = new Date(2026, 10, 21, 22);
  const pick = (id: string, d: Date) => spotlightItems(admin, { id, libraryIds: ['hr-movies'], rotation: 'daily' }, 4, d).map((i) => i.id);
  assert.deepEqual(pick('a', day1), pick('a', later));
  assert.equal(pick('a', day1).length, 4);
  // Different days / rows almost surely differ (12 titles, 4 picks): check over a few days to avoid a fluke.
  const days = [22, 23, 24, 25].map((d) => pick('a', new Date(2026, 10, d, 9)).join());
  assert.ok(days.some((d) => d !== pick('a', day1).join()));
  const someDays = [21, 22, 23, 24, 25].map((d) => new Date(2026, 10, d, 9));
  assert.ok(someDays.some((d) => pick('a', d).join() !== pick('b', d).join()), 'each row has its own shuffle');
});

test('several spotlight rows on the home screen, each with its own title', () => {
  const rows: HomeRowConfig[] = [
    { id: 'rm', type: 'spotlight', enabled: true, title: 'Random Movie', libraryIds: ['hr-movies'], itemTypes: ['movie'], limit: 1 },
    { id: 'rs', type: 'spotlight', enabled: true, title: 'Random Series', itemTypes: ['show'], limit: 5 },
    { id: 'ks', type: 'spotlight', enabled: true, title: 'Kids Spotlight', libraryIds: ['hr-kids'], rotation: 'daily', limit: 10 },
    { id: 'none', type: 'spotlight', enabled: true, title: 'Hidden', libraryIds: ['hr-secret'] },
  ];
  updateBranding({ homeRows: rows });
  const home = buildHome(viewer);
  assert.deepEqual(home.map((r) => r.title), ['Random Movie', 'Random Series', 'Kids Spotlight']);
  assert.equal(home[0]!.items.length, 1);
  assert.ok(home[1]!.items.every((i) => i.type === 'show'));
  assert.equal(home[2]!.items.length, 5);
});

test('top 10: pinned titles first in order, the chart fills the rest, pins the viewer cannot see are skipped', () => {
  // Chart: mov2 (3 viewers) > mov3 (2) > mov4 (1); mov1 is rated R.
  const u = (n: string) => createUser({ username: `hr-p${n}`, password: 'pass1234' }).id;
  const [a, b, c] = [u('a'), u('b'), u('c')];
  for (const x of [a, b, c]) play(x, 'mov2');
  for (const x of [a, b]) play(x, 'mov3');
  play(a, 'mov4');
  play(a, 'mov1');
  clearRecommendationCache();
  const plain = top10Items(viewer, undefined, 10).map((i) => i.item.id);
  assert.deepEqual(plain, ['mov2', 'mov3', 'mov4'], 'chart; mov1 (R) hidden');

  const pins = ['show2', 'sec1', 'mov3', 'mov1', 'kid1', 'ep-x', 'nope'];
  const got = top10Items(viewer, pins, 10);
  assert.deepEqual(got.map((i) => i.item.id), ['show2', 'mov3', 'kid1', 'mov2', 'mov4'], 'pins in order (hidden/unknown/episode skipped), chart without duplicates');
  assert.deepEqual(got.map((i) => i.pinned), [true, true, true, false, false]);
  // The admin sees the pins they may see (all), still in the admin's order.
  assert.deepEqual(top10Items(admin, pins, 10).slice(0, 5).map((i) => i.item.id), ['show2', 'sec1', 'mov3', 'mov1', 'kid1']);
  // Never more than the limit.
  assert.equal(top10Items(viewer, pins, 2).length, 2);

  updateBranding({ homeRows: [{ id: 't10', type: 'top10', enabled: true, title: 'Top', limit: 10, pinnedItemIds: ['kid2'] }] });
  const row = buildHome(viewer).find((r) => r.id === 't10');
  assert.deepEqual(row?.items.map((i) => i.id), ['kid2', 'mov2', 'mov3', 'mov4']);
  // One pin is enough to show the row even with a thin chart.
  const fresh = getUser(createUser({ username: 'hr-fresh', password: 'pass1234', libraryIds: ['hr-kids'] }).id);
  assert.deepEqual(buildHome(fresh).find((r) => r.id === 't10')?.items.map((i) => i.id), ['kid2']);
});
