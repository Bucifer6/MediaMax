// "Previously on…" recaps: built only from episodes the viewer watched before the one about to play (never later
// ones), language-model condensation with strict checks and a list fallback, offered after a break or at a new
// season, recap-marker clip, per-user caching, and library access.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.ts');
const { createUser, getUser } = await import('../src/services/auth.ts');
const { getRecap, acceptRecap, shortOverview } = await import('../src/services/recap.ts');
const { getSettings, updateSettings } = await import('../src/services/settings.ts');

const now = new Date('2026-11-21T20:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString();
const iso = now.toISOString();
db.insert('libraries', { id: 'rc-shows', name: 'Shows', type: 'shows', paths: '[]', created_at: iso });
db.insert('libraries', { id: 'rc-secret', name: 'Secret', type: 'shows', paths: '[]', created_at: iso });
db.insert('items', { id: 'rc-show', library_id: 'rc-shows', type: 'show', title: 'The Harbour', sort_title: 'Harbour', added_at: iso, updated_at: iso });
const OV: Record<string, string> = {
  'rc-s1e1': 'Ana returns to the harbour town after ten years and finds her father missing.',
  'rc-s1e2': 'Ana questions the fishermen; Mihai admits he saw the boat leave at night.',
  'rc-s1e3': 'A storm hits. Ana finds her father\'s logbook hidden in the lighthouse.',
  'rc-s1e4': 'SPOILER-E4: The logbook reveals that Mihai sank the boat on purpose.',
  'rc-s2e1': 'SPOILER-S2: A year later, Ana runs the lighthouse and a stranger arrives.',
};
const TITLES: Record<string, string> = { 'rc-s1e1': 'Homecoming', 'rc-s1e2': 'Tides', 'rc-s1e3': 'The Storm', 'rc-s1e4': 'The Confession of Mihai', 'rc-s2e1': 'Stranger at the Lighthouse' };
const ep = (id: string, season: number, idx: number, lib = 'rc-shows', show = 'rc-show') =>
  db.insert('items', { id, library_id: lib, type: 'episode', title: TITLES[id] ?? id, sort_title: id, overview: OV[id] ?? null, parent_idx: season, idx, grandparent_id: show, parent_id: `${show}-s${season}`, added_at: iso, updated_at: iso });
ep('rc-s1e1', 1, 1);
ep('rc-s1e2', 1, 2);
ep('rc-s1e3', 1, 3);
ep('rc-s1e4', 1, 4);
ep('rc-s2e1', 2, 1);
db.run('UPDATE items SET markers = ? WHERE id = ?', JSON.stringify([{ type: 'intro', startMs: 60000, endMs: 90000 }, { type: 'recap', startMs: 0, endMs: 45000 }]), 'rc-s1e4');
db.insert('items', { id: 'rc-hidden-show', library_id: 'rc-secret', type: 'show', title: 'Hidden', sort_title: 'Hidden', added_at: iso, updated_at: iso });
ep('rc-hidden-e1', 1, 1, 'rc-secret', 'rc-hidden-show');
ep('rc-hidden-e2', 1, 2, 'rc-secret', 'rc-hidden-show');

const viewer = getUser(createUser({ username: 'rc-viewer', password: 'pass1234', libraryIds: ['rc-shows'] }).id);
const other = getUser(createUser({ username: 'rc-other', password: 'pass1234' }).id);
const watch = (u: string, id: string, at: string) => db.run('INSERT INTO user_data (user_id, item_id, played, last_played_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET played = 1, last_played_at = excluded.last_played_at', u, id, at);
// The viewer watched S1E1-E3 ten days ago, and (out of order) peeked at S2E1.
watch(viewer.id, 'rc-s1e1', daysAgo(12));
watch(viewer.id, 'rc-s1e2', daysAgo(11));
watch(viewer.id, 'rc-s1e3', daysAgo(10));
watch(viewer.id, 'rc-s2e1', daysAgo(10));

test('after a 10-day break the next episode offers a recap of the last watched episodes only (stub model)', async () => {
  const sent: string[] = [];
  const chat = async (system: string, user: string) => {
    sent.push(system, user);
    return 'Ana came back to the harbour town and learned her father had vanished. Mihai admitted he saw the boat leave at night. During a storm, Ana found her father\'s logbook hidden in the lighthouse.';
  };
  const r = await getRecap(viewer, 'rc-s1e4', { now, chat });
  assert.equal(r.available, true);
  assert.equal(r.reason, 'gap');
  assert.equal(r.daysSinceLastWatched, 10);
  assert.deepEqual(r.episodes.map((e) => e.id), ['rc-s1e1', 'rc-s1e2', 'rc-s1e3']);
  assert.equal(r.by, 'llm');
  assert.match(r.text!, /logbook/);
  // Spoiler wall: nothing from the episode about to play or anything after it ever reaches the model.
  const all = sent.join('\n');
  assert.ok(!all.includes('SPOILER'), 'no later overview sent');
  assert.ok(!all.includes('Confession of Mihai') && !all.includes('Stranger at the Lighthouse'), 'no later titles sent');
  assert.match(sent[0], /never mention, hint at or speculate about anything that happens after the last summary/);
  // The recap marker of the episode about to play becomes the optional clip.
  assert.deepEqual(r.clip, { itemId: 'rc-s1e4', startMs: 0, endMs: 45000 });
  assert.equal(r.bullets.length, 3);
  assert.ok(r.bullets.every((b) => !b.includes('SPOILER')));
  assert.match(r.bullets[0], /^S01E01 · Homecoming — Ana returns/);
});

test('cached per (user, show, last watched episode): no second model call', async () => {
  let calls = 0;
  const r = await getRecap(viewer, 'rc-s1e4', { now, chat: async () => (calls++, 'x') });
  assert.equal(calls, 0);
  assert.equal(r.by, 'llm');
  assert.match(r.text!, /logbook/);
});

test('a model reply that leaks a later episode, or rambles, is rejected for the plain list', async () => {
  assert.equal(acceptRecap('Ana found the logbook. Later, in The Confession of Mihai, everything changes. It is great.', ['The Confession of Mihai']), null);
  assert.equal(acceptRecap('Too short.', []), null);
  assert.equal(acceptRecap('- bullet one\n- bullet two', []), null);
  assert.ok(acceptRecap('**Previously on:** Ana came home. Her father was gone. She found a logbook.', []));
  db.run('DELETE FROM recap_cache');
  const r = await getRecap(viewer, 'rc-s1e4', { now, chat: async () => 'Ana returned home. She found the logbook. Next, in The Confession of Mihai, the truth comes out.' });
  assert.equal(r.by, 'list');
  assert.equal(r.text, null);
  assert.equal(r.bullets.length, 3);
});

test('without a language model: a tidy list of the watched episodes', async () => {
  db.run('DELETE FROM recap_cache');
  updateSettings({ ai: { ...getSettings().ai!, llm: { provider: 'none', url: null, model: null, apiKey: null, maxRequestsPerDay: 0 } } });
  const r = await getRecap(viewer, 'rc-s1e4', { now });
  assert.equal(r.by, 'list');
  assert.equal(r.text, null);
  assert.deepEqual(r.episodes.map((e) => e.id), ['rc-s1e1', 'rc-s1e2', 'rc-s1e3']);
  assert.ok(shortOverview('x'.repeat(400)).length <= 262);
});

test('no recap after a short break; the "Recap" button forces one; a new season always offers one', async () => {
  const u = getUser(createUser({ username: 'rc-binger', password: 'pass1234', libraryIds: ['rc-shows'] }).id);
  watch(u.id, 'rc-s1e1', daysAgo(2));
  watch(u.id, 'rc-s1e2', daysAgo(1));
  const r = await getRecap(u, 'rc-s1e3', { now });
  assert.equal(r.available, false);
  assert.equal(r.daysSinceLastWatched, 1);
  const forced = await getRecap(u, 'rc-s1e3', { now, force: true });
  assert.equal(forced.available, true);
  assert.deepEqual(forced.episodes.map((e) => e.id), ['rc-s1e1', 'rc-s1e2']);
  watch(u.id, 'rc-s1e3', daysAgo(1));
  watch(u.id, 'rc-s1e4', daysAgo(1));
  const season2 = await getRecap(u, 'rc-s2e1', { now });
  assert.equal(season2.available, true);
  assert.equal(season2.reason, 'new-season');
  assert.deepEqual(season2.episodes.map((e) => e.id), ['rc-s1e2', 'rc-s1e3', 'rc-s1e4'], 'the last three, configurable');
  updateSettings({ ai: { ...getSettings().ai!, recaps: { minGapDays: 7, maxEpisodes: 1 } } });
  db.run('DELETE FROM recap_cache');
  assert.deepEqual((await getRecap(u, 'rc-s2e1', { now })).episodes.map((e) => e.id), ['rc-s1e4']);
  updateSettings({ ai: { ...getSettings().ai!, recaps: { minGapDays: 7, maxEpisodes: 3 } } });
});

test('per user: someone who has watched nothing gets no recap; hidden shows are not found; feature switch', async () => {
  assert.equal((await getRecap(other, 'rc-s1e4', { now, force: true })).available, false);
  await assert.rejects(getRecap(viewer, 'rc-hidden-e2', { now }), /not found/i);
  updateSettings({ ai: { ...getSettings().ai!, features: { ...getSettings().ai!.features, recaps: false } } });
  assert.equal((await getRecap(viewer, 'rc-s1e4', { now })).available, false);
  updateSettings({ ai: { ...getSettings().ai!, features: { ...getSettings().ai!.features, recaps: true } } });
  await assert.rejects(getRecap(viewer, 'rc-show', { now }), /episodes/);
});
