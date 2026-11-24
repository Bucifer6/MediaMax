// AI provider chains: ordered fallback with cooldowns (exponential, Retry-After), daily caps, silent failure (null,
// never a throw), the request shapes of each API kind, write-only keys, the migration of the old single-model /
// single-voice settings, and the admin health / test endpoints. Every outbound request goes to a stubbed fetch.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Call = { url: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let handler: (c: Call) => Response | Promise<Response> = () => new Response('nope', { status: 500 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  let body: any = init?.body;
  try {
    body = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    /* text */
  }
  const c = { url, headers, body };
  calls.push(c);
  return handler(c);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});
const json = (v: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...h } });
const okChat = (text: string) => json({ choices: [{ message: { content: text } }] });

// A server from before provider chains: one model (ai.llm) and one DJ voice (aiDj.tts).
const { setKv, getSettings, publicSettings, updateSettings } = await import('../src/services/settings.ts');
setKv('server', {
  ai: { llm: { provider: 'openai', url: 'https://api.groq.com/openai/v1', model: 'llama', apiKey: 'gsk-secret', maxRequestsPerDay: 0 }, features: { dj: true, ask: true, recaps: true, autoSubtitles: false } },
  aiDj: { enabled: true, chattiness: 'normal', hostName: 'Max', llm: { provider: 'none' }, tts: { provider: 'openai', url: 'http://nas:8880/v1', model: 'kokoro', voice: 'af_heart', apiKey: null } },
});
const { llmChat, resetLlmBudget, llmConfigured } = await import('../src/services/ai/llm.ts');
const { resetChainState, providerHealth, fallbackEvents, retryAfterMs, runChain } = await import('../src/services/ai/chain.ts');
const { speakChain } = await import('../src/services/ai/tts.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { buildApp } = await import('../src/app.ts');

beforeEach(() => {
  calls = [];
  resetChainState();
  resetLlmBudget();
});

test('migration: the old single model and the DJ voice become one-item chains', () => {
  const ai = getSettings().ai!;
  assert.equal(ai.llmProviders!.length, 1);
  const p = ai.llmProviders![0];
  assert.deepEqual([p.id, p.kind, p.url, p.model, p.enabled, p.name], ['default', 'openai', 'https://api.groq.com/openai/v1', 'llama', true, 'Groq']);
  assert.equal(p.apiKey, 'gsk-secret');
  assert.equal(ai.ttsProviders!.length, 1);
  assert.deepEqual([ai.ttsProviders![0].kind, ai.ttsProviders![0].url, ai.ttsProviders![0].voice], ['kokoro', 'http://nas:8880/v1', 'af_heart']);
  // New options default to off / no outbound requests.
  assert.equal(ai.weatherLocation, null);
  assert.equal(ai.onlineFacts, false);
  assert.equal(ai.djTrackCooldownDays, 7);
  assert.ok(llmConfigured());
});

test('keys are write-only: never returned, kept on save, replaced or removed explicitly', () => {
  const pub = publicSettings().ai!;
  assert.equal((pub.llmProviders![0] as { apiKey?: string }).apiKey, undefined);
  assert.equal(pub.llmProviders![0].hasKey, true);
  assert.ok(!JSON.stringify(publicSettings()).includes('gsk-secret'));
  // Saving the page back (no key in the payload) keeps the stored key.
  updateSettings({ ai: { ...pub, llmProviders: [...pub.llmProviders!, { id: 'or', name: 'OpenRouter', kind: 'openai', url: 'https://openrouter.ai/api/v1', model: 'x:free', enabled: true, apiKey: 'or-key' }] } });
  assert.equal(getSettings().ai!.llmProviders![0].apiKey, 'gsk-secret');
  assert.equal(getSettings().ai!.llmProviders![1].apiKey, 'or-key');
  // A hasKey sent by a client is ignored; '' removes the key; the mask keeps it.
  const pub2 = publicSettings().ai!;
  updateSettings({ ai: { ...pub2, llmProviders: [{ ...pub2.llmProviders![0], apiKey: '••••' }, { ...pub2.llmProviders![1], apiKey: '', hasKey: true }] } });
  assert.equal(getSettings().ai!.llmProviders![0].apiKey, 'gsk-secret');
  assert.equal(getSettings().ai!.llmProviders![1].apiKey, null);
  assert.equal(publicSettings().ai!.llmProviders![1].hasKey, false);
  // Back to one provider for the next tests.
  updateSettings({ ai: { ...publicSettings().ai!, llmProviders: [publicSettings().ai!.llmProviders![0]] } });
  assert.equal(getSettings().ai!.llmProviders!.length, 1);
});

function setChain(list: object[]) {
  updateSettings({ ai: { ...getSettings().ai!, llmProviders: list as never } });
}

test('fallback order: a failing provider cools down and the next answers; all failing returns null silently', async () => {
  setChain([
    { id: 'a', name: 'A', kind: 'openai', url: 'http://a.test/v1', model: 'm', enabled: true },
    { id: 'off', name: 'Off', kind: 'openai', url: 'http://off.test/v1', model: 'm', enabled: false },
    { id: 'b', name: 'B', kind: 'openai', url: 'http://b.test/v1', model: 'm', enabled: true },
  ]);
  handler = (c) => (c.url.startsWith('http://a.test') ? new Response('overloaded', { status: 503 }) : okChat('from B'));
  assert.equal(await llmChat('s', 'u', { feature: 'dj' }), 'from B');
  assert.deepEqual(calls.map((c) => new URL(c.url).host), ['a.test', 'b.test'], 'disabled providers are skipped');
  // A is cooling down now: the next call goes straight to B.
  calls = [];
  assert.equal(await llmChat('s', 'u', { feature: 'dj' }), 'from B');
  assert.deepEqual(calls.map((c) => new URL(c.url).host), ['b.test']);
  const h = providerHealth('llm', getSettings().ai!.llmProviders!);
  const a = h.find((x) => x.id === 'a')!;
  assert.equal(a.ok, false);
  assert.match(a.lastError!, /HTTP 503/);
  const cool = Date.parse(a.cooldownUntil!) - Date.now();
  assert.ok(cool > 50000 && cool <= 60000, `first cooldown ~1 min, got ${cool}`);
  assert.equal(h.find((x) => x.id === 'b')!.calls24h, 2);
  const ev = fallbackEvents();
  assert.ok(ev.some((e) => e.from === 'a' && e.to === 'b' && /503/.test(e.reason) && e.feature === 'dj'));
  // Everything failing: null (the caller's built-in fallback), never a throw; logged as → builtin.
  resetChainState();
  handler = () => {
    throw new TypeError('fetch failed');
  };
  assert.equal(await llmChat('s', 'u', { feature: 'ask' }), null);
  assert.ok(fallbackEvents().some((e) => e.from === 'b' && e.to === 'builtin' && /network error/.test(e.reason)));
});

test('cooldown grows exponentially; Retry-After is honoured; auth/quota errors start further up', async () => {
  let t = Date.now();
  const now = () => t;
  const p = [{ id: 'x', name: 'X', enabled: true }];
  const fail = (status: number, ra?: string) => async () => {
    throw Object.assign(new (await import('../src/services/ai/chain.ts')).ProviderError(`HTTP ${status}`, status, retryAfterMs(ra)));
  };
  const cooldown = () => Date.parse(providerHealth('llm', p, t)[0].cooldownUntil!) - t;
  await runChain('llm', p, fail(500), { feature: 't', now });
  assert.equal(cooldown(), 60000);
  t += 61000;
  await runChain('llm', p, fail(500), { feature: 't', now });
  assert.equal(cooldown(), 5 * 60000);
  t += 5 * 60000 + 1000;
  await runChain('llm', p, fail(500), { feature: 't', now });
  assert.equal(cooldown(), 15 * 60000);
  // While cooling down the provider isn't called at all.
  let called = false;
  assert.equal(await runChain('llm', p, async () => ((called = true), 'x'), { feature: 't', now }), null);
  assert.equal(called, false);
  // Success resets; a 429 with Retry-After 1200 s waits 20 min.
  resetChainState();
  await runChain('llm', p, fail(429, '1200'), { feature: 't', now });
  assert.equal(cooldown(), 1200000);
  assert.equal(retryAfterMs(new Date(Date.now() + 90000).toUTCString())! > 80000, true);
  // 401 / 402 / 403 (bad key, quota): 15 minutes straight away.
  resetChainState();
  await runChain('llm', p, fail(401), { feature: 't', now });
  assert.equal(cooldown(), 15 * 60000);
});

test('the real HTTP path: 429 + Retry-After from the server, invalid output moves on, daily caps', async () => {
  setChain([
    { id: 'a', name: 'A', kind: 'openai', url: 'http://a.test/v1', model: 'm', enabled: true, paid: true, dailyCap: 1 },
    { id: 'b', name: 'B', kind: 'openai', url: 'http://b.test/v1', model: 'm', enabled: true },
  ]);
  handler = (c) => (c.url.startsWith('http://a.test') ? json({ error: 'slow down' }, 429, { 'retry-after': '600' }) : okChat('B'));
  assert.equal(await llmChat('s', 'u'), 'B');
  const a = providerHealth('llm', getSettings().ai!.llmProviders!).find((x) => x.id === 'a')!;
  assert.ok(Date.parse(a.cooldownUntil!) - Date.now() > 590000, 'Retry-After 600 s');
  // Invalid output (empty, or rejected by the caller's validator) is a failure too.
  resetChainState();
  handler = (c) => (c.url.startsWith('http://a.test') ? okChat('not json at all') : okChat('{"ok":true}'));
  assert.equal(await llmChat('s', 'u', { validate: (t) => t.startsWith('{') }), '{"ok":true}');
  assert.ok(fallbackEvents().some((e) => e.from === 'a' && e.reason === 'invalid output'));
  // Daily cap of 1: after one call today A is skipped without a request.
  resetChainState();
  handler = (c) => okChat(new URL(c.url).host);
  assert.equal(await llmChat('s', 'u'), 'a.test');
  calls = [];
  assert.equal(await llmChat('s', 'u'), 'b.test');
  assert.deepEqual(calls.map((c) => new URL(c.url).host), ['b.test']);
  assert.ok(fallbackEvents().some((e) => e.from === 'a' && e.reason === 'daily cap reached'));
});

test('request shapes: Anthropic Messages, Gemini generateContent, native Ollama', async () => {
  setChain([{ id: 'an', name: 'Anthropic', kind: 'anthropic', url: 'https://api.anthropic.com', model: 'claude-x', enabled: true, apiKey: 'sk-ant' }]);
  handler = () => json({ content: [{ type: 'text', text: 'hello from claude' }] });
  assert.equal(await llmChat('be brief', 'hi', { maxTokens: 50 }), 'hello from claude');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].body.system, 'be brief');
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(calls[0].body.max_tokens, 50);

  calls = [];
  setChain([{ id: 'ge', name: 'Gemini', kind: 'gemini', url: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash', enabled: true, apiKey: 'AIza' }]);
  handler = () => json({ candidates: [{ content: { parts: [{ text: 'hi from gemini' }] } }] });
  assert.equal(await llmChat('sys', 'u', { json: true }), 'hi from gemini');
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
  assert.equal(calls[0].headers['x-goog-api-key'], 'AIza');
  assert.ok(!calls[0].url.includes('AIza'), 'the key is not in the URL');
  assert.equal(calls[0].body.systemInstruction.parts[0].text, 'sys');
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');

  calls = [];
  setChain([{ id: 'ol', name: 'Ollama', kind: 'ollama', url: 'http://localhost:11434', model: 'llama3.2:3b', enabled: true }]);
  handler = () => json({ message: { content: 'local' } });
  assert.equal(await llmChat('s', 'u'), 'local');
  assert.equal(calls[0].url, 'http://localhost:11434/api/chat');
  assert.equal(calls[0].headers.authorization, undefined);
});

test('TTS chain: ElevenLabs shape, fallback to the next voice, null (device voice) when all fail', async () => {
  const mp3 = new Uint8Array(4000).fill(7);
  updateSettings({ ai: { ...getSettings().ai!, ttsProviders: [
    { id: 'el', name: 'ElevenLabs', kind: 'elevenlabs', url: 'https://api.elevenlabs.io', model: 'eleven_flash_v2_5', voice: 'voice123', enabled: true, apiKey: 'xi' },
    { id: 'ko', name: 'Kokoro', kind: 'kokoro', url: 'http://nas:8880/v1', model: 'kokoro', voice: 'af_heart', enabled: true },
  ] as never } });
  handler = (c) => (c.url.includes('elevenlabs') ? json({ detail: 'quota_exceeded' }, 401) : new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }));
  const v = await speakChain('Hello there, chain test one.');
  assert.ok(v && /^[a-f0-9]{32}\.mp3$/.test(v.file));
  assert.equal(v!.providerId, 'ko');
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128');
  assert.equal(calls[0].headers['xi-api-key'], 'xi');
  assert.equal(calls[0].body.model_id, 'eleven_flash_v2_5');
  assert.equal(calls[1].url, 'http://nas:8880/v1/audio/speech');
  assert.equal(calls[1].body.voice, 'af_heart');
  // Cached: no request the second time.
  calls = [];
  assert.equal((await speakChain('Hello there, chain test one.'))!.file, v!.file);
  assert.equal(calls.length, 0);
  // Nothing works: null, silently.
  resetChainState();
  handler = () => new Response('down', { status: 502 });
  assert.equal(await speakChain('Another line nobody can render.'), null);
  assert.ok(fallbackEvents().some((e) => e.to === 'builtin'));
});

test('admin endpoints: health + fallback log, explicit provider test; admin only', async () => {
  const app = await buildApp();
  after(() => app.close());
  const admin = await createUser({ username: 'chain-admin', password: 'pass1234', isAdmin: true });
  const viewer = await createUser({ username: 'chain-viewer', password: 'pass1234' });
  const tok = (id: string, d: string) => issueToken(id, { deviceId: d, deviceName: 'test', platform: 'web' }).token;
  const A = { authorization: `Bearer ${tok(admin.id, 'ch-a')}` };
  const V = { authorization: `Bearer ${tok(viewer.id, 'ch-v')}` };
  setChain([{ id: 'a', name: 'A', kind: 'openai', url: 'http://a.test/v1', model: 'm', enabled: true, apiKey: 'k-a' }]);
  assert.equal((await app.inject({ url: '/api/v1/ai/health', headers: V })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/ai/providers/test', headers: V, payload: { kind: 'llm', providerId: 'a' } })).statusCode, 403);
  handler = () => new Response('bad key', { status: 401 });
  const t1 = (await app.inject({ method: 'POST', url: '/api/v1/ai/providers/test', headers: A, payload: { kind: 'llm', providerId: 'a' } })).json();
  assert.equal(t1.ok, false);
  assert.match(t1.error, /401/);
  // The test ignores the cooldown it just caused.
  handler = () => okChat('OK');
  const t2 = (await app.inject({ method: 'POST', url: '/api/v1/ai/providers/test', headers: A, payload: { kind: 'llm', providerId: 'a' } })).json();
  assert.equal(t2.ok, true);
  assert.equal(t2.sample, 'OK');
  const h = (await app.inject({ url: '/api/v1/ai/health', headers: A })).json();
  assert.ok(h.providers.some((p: { id: string; kind: string; ok: boolean }) => p.id === 'a' && p.kind === 'llm' && p.ok));
  assert.ok(Array.isArray(h.events));
  assert.ok(!JSON.stringify(h).includes('k-a'));
  // GET /settings never carries chain keys.
  const s = (await app.inject({ url: '/api/v1/settings', headers: A })).json();
  assert.ok(!JSON.stringify(s.ai.llmProviders).includes('k-a'));
  assert.equal(s.ai.llmProviders[0].hasKey, true);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/ai/providers/test', headers: A, payload: { kind: 'llm', providerId: 'nope' } })).statusCode, 400);
});

test('older clients editing the single ai.llm still steer the chain', () => {
  setChain([{ id: 'default', name: 'Groq', kind: 'openai', url: 'https://api.groq.com/openai/v1', model: 'llama', enabled: true, apiKey: 'gsk' }]);
  const cur = getSettings().ai!;
  updateSettings({ ai: { ...cur, llm: { ...cur.llm, model: 'llama-big' } } });
  assert.equal(getSettings().ai!.llmProviders![0].model, 'llama-big');
  updateSettings({ ai: { ...getSettings().ai!, llm: { ...getSettings().ai!.llm, provider: 'none' } } });
  assert.equal(llmConfigured(), false);
  assert.equal(getSettings().ai!.llmProviders![0].enabled, false);
});
