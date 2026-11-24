// AI HTTP routes: Ask and recaps for users (feature switches, validation), Admin → AI endpoints admin-only,
// and the AI settings round trip through PUT /settings with the key kept write-only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { createUser, issueToken } = await import('../src/services/auth.ts');
const { getSettings, updateSettings } = await import('../src/services/settings.ts');
const { db } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');

const app = await buildApp();
after(() => app.close());

const admin = await createUser({ username: 'air-admin', password: 'pass1234', isAdmin: true });
const viewer = await createUser({ username: 'air-viewer', password: 'pass1234' });
const tok = (id: string, d: string) => issueToken(id, { deviceId: d, deviceName: 'test', platform: 'web' }).token;
const A = { authorization: `Bearer ${tok(admin.id, 'air-a')}` };
const V = { authorization: `Bearer ${tok(viewer.id, 'air-v')}` };
const now = new Date().toISOString();
db.insert('libraries', { id: 'air-lib', name: 'Movies', type: 'movies', paths: '[]', created_at: now });
db.insert('items', { id: 'air-m1', library_id: 'air-lib', type: 'movie', title: 'Laugh Track', sort_title: 'Laugh Track', genres: '["Comedy"]', year: 2004, duration_ms: 85 * 60000, added_at: now, updated_at: now });

test('POST /ask: users get results and chips; bad input is rejected; the switch turns it off', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/ask', headers: V, payload: { q: 'comedies from the 2000s under 90 minutes' } });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.deepEqual(j.items.map((i: { id: string }) => i.id), ['air-m1']);
  assert.ok(j.chips.some((c: { label: string }) => c.label === '2000s'));
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/ask', headers: V, payload: { q: '' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/ask', payload: { q: 'x' } })).statusCode, 401);
  const removed = await app.inject({ method: 'POST', url: '/api/v1/ask', headers: V, payload: { q: 'comedies from the 2000s', filter: j.filter, remove: ['years'] } });
  assert.ok(!removed.json().chips.some((c: { key: string }) => c.key === 'years'));
  updateSettings({ ai: { ...getSettings().ai!, features: { ...getSettings().ai!.features, ask: false } } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/ask', headers: V, payload: { q: 'comedy' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/v1/ai/features', headers: V })).json().ask, false);
  updateSettings({ ai: { ...getSettings().ai!, features: { ...getSettings().ai!.features, ask: true } } });
});

test('Admin → AI endpoints are admin-only', async () => {
  for (const [method, url] of [['GET', '/api/v1/ai/status'], ['GET', '/api/v1/ai/subtitles'], ['POST', '/api/v1/ai/subtitles/run'], ['POST', '/api/v1/ai/whisper/download'], ['POST', '/api/v1/ai/test']] as const) {
    assert.equal((await app.inject({ method, url, headers: V, payload: {} })).statusCode, 403, url);
  }
  const s = await app.inject({ url: '/api/v1/ai/status', headers: A });
  assert.equal(s.statusCode, 200);
  assert.equal(s.json().llmConfigured, false);
  const subs = (await app.inject({ url: '/api/v1/ai/subtitles', headers: A })).json();
  assert.equal(subs.enabled, false, 'automatic subtitles are off by default');
  assert.ok(subs.models.base.mb > 100);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/ai/subtitles/run', headers: A, payload: {} })).statusCode, 400, 'off → cannot run');
  const q = await app.inject({ method: 'POST', url: '/api/v1/ai/subtitles/queue', headers: A, payload: { itemId: 'air-m1', language: 'ro' } });
  assert.equal(q.statusCode, 400, 'no local media file');
});

test('AI settings round-trip through PUT /settings; keys stay write-only', async () => {
  const cur = (await app.inject({ url: '/api/v1/settings', headers: A })).json();
  const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: A, payload: { ai: { ...cur.ai, llm: { provider: 'openai', url: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'sk-1', maxRequestsPerDay: 10 } } } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().ai.llm.apiKey, '••••');
  assert.equal(put.json().aiDj.llm.apiKey, '••••');
  assert.equal(getSettings().ai!.llm.apiKey, 'sk-1');
  assert.equal(getSettings().aiDj.llm.model, 'm', 'the DJ sees the shared model');
  const status = (await app.inject({ url: '/api/v1/dj/status', headers: V })).json();
  assert.equal(status.ai.llm, true);
});

test('GET /items/:id/recap: only episodes', async () => {
  const r = await app.inject({ url: '/api/v1/items/air-m1/recap', headers: V });
  assert.equal(r.statusCode, 400);
});
