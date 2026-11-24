// Item API follow-ups: list responses leave out cast & crew (detail keeps it); collection counts only what the viewer sees.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { createContainer } = await import('../src/services/items.ts');
const { buildApp } = await import('../src/app.ts');

const now = new Date().toISOString();
const cast = Array.from({ length: 30 }, (_, k) => ({ name: `Actor ${k}`, role: `Role ${k}`, kind: k === 0 ? 'director' : 'actor', imageUrl: null }));
db.insert('libraries', { id: 'if-movies', name: 'Movies', type: 'movies', paths: '[]', created_at: now });
db.insert('libraries', { id: 'if-secret', name: 'Secret', type: 'movies', paths: '[]', created_at: now });
const movie = (id: string, lib: string) =>
  db.insert('items', { id, library_id: lib, type: 'movie', title: `Film ${id}`, sort_title: `film ${id}`, people: JSON.stringify(cast), genres: '["Drama"]', added_at: now, updated_at: now });
for (let k = 1; k <= 4; k++) movie(`if-m${k}`, 'if-movies');
for (let k = 1; k <= 3; k++) movie(`if-s${k}`, 'if-secret');

const admin = await createUser({ username: 'if-admin', password: 'pw-123456', isAdmin: true });
const viewer = await createUser({ username: 'if-viewer', password: 'pw-123456', libraryIds: ['if-movies'] });
const vtok = issueToken(viewer.id, { deviceId: 'if-v', deviceName: 'test', platform: 'web' }).token;
const atok = issueToken(admin.id, { deviceId: 'if-a', deviceName: 'test', platform: 'web' }).token;
const coll = createContainer('collection', 'Mixed', null, ['if-m1', 'if-s1', 'if-m2', 'if-s2', 'if-s3']);
db.run("INSERT INTO watchlist (user_id, item_id, added_at) VALUES (?, 'if-m1', ?)", viewer.id, now);

const app = await buildApp();
after(() => app.close());
const get = async (url: string, tok = vtok) => {
  const r = await app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${tok}` } });
  assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  return r.json();
};

test('list responses carry no cast & crew; item detail keeps all of it', async () => {
  const lists: [string, any[]][] = [
    ['library page', (await get('/items?libraryId=if-movies&type=movie')).items],
    ['children', (await get(`/items/${coll}/children`)).items],
    ['search', (await get('/search?q=Film')).items],
    ['watchlist', (await get('/watchlist')).items],
    ['similar', await get('/items/if-m1/similar')],
  ];
  for (const [name, items] of lists) {
    assert.ok(items.length > 0, `${name} returned items`);
    for (const it of items) assert.equal(it.people, undefined, `${name}: ${it.id} has no people`);
  }
  const detail = await get('/items/if-m1');
  assert.equal(detail.people.length, 30, 'detail keeps the full cast');
  assert.equal(detail.people[0].kind, 'director');
});

test('collection children total counts only items the viewer may see', async () => {
  const v = await get(`/items/${coll}/children`);
  assert.deepEqual(v.items.map((i: any) => i.id), ['if-m1', 'if-m2']);
  assert.equal(v.total, 2, 'hidden items are not counted');
  const a = await get(`/items/${coll}/children`, atok);
  assert.equal(a.total, 5);
});
