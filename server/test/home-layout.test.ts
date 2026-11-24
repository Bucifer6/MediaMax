// "Customize Home": per-profile hidden rows and row order (UserPreferences.homeLayout), applied by the home builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HomeRow } from '@mediamax/shared';

const { db } = await import('../src/db.ts');
const { createUser, getUser, updateMe } = await import('../src/services/auth.ts');
const { applyHomeLayout, buildHome } = await import('../src/services/items.ts');
const { updateBranding } = await import('../src/services/branding.ts');

const row = (id: string): HomeRow => ({ id, type: 'genre', title: id, items: [] });
const ids = (rows: HomeRow[]) => rows.map((r) => r.id);

test('no layout (or an empty one) keeps the server order', () => {
  const rows = ['a', 'b', 'c'].map(row);
  assert.deepEqual(ids(applyHomeLayout(rows, undefined)), ['a', 'b', 'c']);
  assert.deepEqual(ids(applyHomeLayout(rows, { hidden: [], order: [] })), ['a', 'b', 'c']);
  assert.deepEqual(ids(applyHomeLayout(rows, 'junk')), ['a', 'b', 'c']);
});

test('hidden rows are dropped; ordered rows first, the rest keep their relative server order', () => {
  const rows = ['continue', 'nextup', 'recent', 'genre', 'top10'].map(row);
  const out = applyHomeLayout(rows, { hidden: ['recent'], order: ['top10', 'continue'] });
  assert.deepEqual(ids(out), ['top10', 'continue', 'nextup', 'genre']);
  // Unknown ids in the layout are ignored; junk entries are skipped.
  assert.deepEqual(ids(applyHomeLayout(rows, { hidden: ['nope', 42], order: ['missing', 'genre', null] })), ['genre', 'continue', 'nextup', 'recent', 'top10']);
});

test('a base id covers the rows it expands to; an exact id wins', () => {
  const rows = ['continue', 'lib:movies', 'lib:shows', 'lib:music', 'top10'].map(row);
  assert.deepEqual(ids(applyHomeLayout(rows, { hidden: ['lib'], order: [] })), ['continue', 'top10']);
  assert.deepEqual(ids(applyHomeLayout(rows, { hidden: ['lib:shows'], order: ['lib:music', 'top10'] })), ['lib:music', 'top10', 'continue', 'lib:movies']);
  assert.deepEqual(ids(applyHomeLayout(rows, { hidden: [], order: ['lib', 'lib:music'] })), ['lib:movies', 'lib:shows', 'lib:music', 'continue', 'top10']);
});

test('buildHome applies each profile\'s own layout', async () => {
  const now = new Date().toISOString();
  db.insert('libraries', { id: 'hl-movies', name: 'Films', type: 'movies', paths: '[]', created_at: now });
  for (let i = 1; i <= 3; i++) db.insert('items', { id: `hl${i}`, library_id: 'hl-movies', type: 'movie', title: `HL ${i}`, sort_title: `hl ${i}`, added_at: now, updated_at: now });
  updateBranding({
    homeRows: [
      { id: 'recent', type: 'recent', enabled: true },
      { id: 'lib-recent', type: 'library-recent', enabled: true },
      { id: 'spot', type: 'spotlight', enabled: true, title: 'Spotlight' },
    ],
  });
  const a = await createUser({ username: 'hl-a', password: 'pass1234', isAdmin: true });
  const b = await createUser({ username: 'hl-b', password: 'pass1234' });
  const before = ids(buildHome(getUser(a.id)));
  assert.deepEqual(before, ['recent', 'lib-recent:hl-movies', 'spot']);
  await updateMe(a.id, { preferences: { homeLayout: { hidden: ['recent'], order: ['spot'] } } });
  assert.deepEqual(ids(buildHome(getUser(a.id))), ['spot', 'lib-recent:hl-movies']);
  // Another profile is unaffected.
  assert.deepEqual(ids(buildHome(getUser(b.id))), before);
  // Reset to default.
  await updateMe(a.id, { preferences: { homeLayout: { hidden: [], order: [] } } });
  assert.deepEqual(ids(buildHome(getUser(a.id))), before);
});
