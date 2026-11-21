// Shared AI settings (Admin → AI): the DJ's language model moves to `ai.llm` transparently, stays mirrored, keeps
// its key write-only, and every feature degrades to its built-in behaviour with provider 'none' or switched off.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { setKv, getSettings, publicSettings, updateSettings, SECRET_MASK } = await import('../src/services/settings.ts');

// A stub OpenAI-compatible chat server that counts calls.
let calls = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
after(() => server.close());

// Settings as stored by a server from before the AI section existed: the model lives under aiDj.llm.
setKv('server', {
  aiDj: { enabled: true, chattiness: 'chatty', hostName: 'Ana', llm: { provider: 'openai', url, model: 'tiny-model', apiKey: 'sk-secret', maxRequestsPerDay: 2 }, tts: { provider: 'device' } },
});

const { llmChat: djChat, hostLine } = await import('../src/services/dj/ai.ts');
const { llmChat, llmAvailable, llmConfigured, llmUsage, resetLlmBudget } = await import('../src/services/ai/llm.ts');

test('the DJ language model becomes the shared AI model without any admin action', () => {
  const s = getSettings();
  assert.equal(s.ai!.llm.provider, 'openai');
  assert.equal(s.ai!.llm.url, url);
  assert.equal(s.ai!.llm.model, 'tiny-model');
  assert.equal(s.ai!.llm.apiKey, 'sk-secret');
  assert.equal(s.ai!.llm.maxRequestsPerDay, 2);
  // DJ settings are untouched and still describe the same model.
  assert.equal(s.aiDj.hostName, 'Ana');
  assert.equal(s.aiDj.chattiness, 'chatty');
  assert.deepEqual(s.aiDj.llm, s.ai!.llm);
  // Defaults for the new features: Ask and recaps on, automatic subtitles off.
  assert.deepEqual(s.ai!.features, { dj: true, ask: true, recaps: true, autoSubtitles: false });
  assert.equal(s.ai!.recaps.minGapDays, 7);
  assert.equal(s.ai!.autoSubtitles.windowStart, '01:00');
  assert.ok(llmConfigured());
});

test('keys stay write-only in both places; the masked value keeps the stored key', () => {
  const pub = publicSettings();
  assert.equal(pub.ai!.llm.apiKey, SECRET_MASK);
  assert.equal(pub.aiDj.llm.apiKey, SECRET_MASK);
  // The admin page saves the whole object back with masks.
  updateSettings({ ...pub });
  assert.equal(getSettings().ai!.llm.apiKey, 'sk-secret');
  assert.equal(getSettings().aiDj.llm.apiKey, 'sk-secret');
  updateSettings({ ai: { ...pub.ai!, autoSubtitles: { ...pub.ai!.autoSubtitles, apiKey: 'stt-key' } } });
  assert.equal(publicSettings().ai!.autoSubtitles.apiKey, SECRET_MASK);
  updateSettings({ ai: publicSettings().ai });
  assert.equal(getSettings().ai!.autoSubtitles.apiKey, 'stt-key');
  assert.equal(getSettings().ai!.llm.apiKey, 'sk-secret');
});

test('the DJ keeps working: chat goes through the shared model and its daily cap', async () => {
  resetLlmBudget();
  calls = 0;
  assert.equal(await djChat('sys', 'hi', { maxTokens: 5 }), 'OK');
  assert.equal(calls, 1);
  // The cap (2/day) is shared by every feature.
  assert.equal(await llmChat('sys', 'hi', { feature: 'ask' }), 'OK');
  assert.equal(await llmChat('sys', 'hi', { feature: 'recaps' }), null, 'over the shared daily cap');
  assert.equal(calls, 2);
  assert.equal(llmUsage().used, 2);
  resetLlmBudget();
});

test('older clients that still save aiDj.llm update the shared model; ai.llm is mirrored back to aiDj.llm', () => {
  const cur = getSettings();
  updateSettings({ aiDj: { ...cur.aiDj, llm: { ...cur.aiDj.llm, model: 'other-model' } } });
  assert.equal(getSettings().ai!.llm.model, 'other-model');
  updateSettings({ ai: { ...getSettings().ai!, llm: { ...getSettings().ai!.llm, model: 'third-model', maxRequestsPerDay: 50 } } });
  assert.equal(getSettings().aiDj.llm.model, 'third-model');
  assert.equal(getSettings().aiDj.llm.maxRequestsPerDay, 50);
  // Junk is normalised, not stored.
  updateSettings({ ai: { ...getSettings().ai!, recaps: { minGapDays: -4 as number, maxEpisodes: 9 }, autoSubtitles: { ...getSettings().ai!.autoSubtitles, windowStart: '25:99', languages: ['RO', 'xx-long', 'en'] } } });
  assert.equal(getSettings().ai!.recaps.minGapDays, 0);
  assert.equal(getSettings().ai!.recaps.maxEpisodes, 3);
  assert.equal(getSettings().ai!.autoSubtitles.windowStart, '01:00');
  assert.deepEqual(getSettings().ai!.autoSubtitles.languages, ['ro', 'en']);
});

test('switching a feature off stops its model calls; the DJ falls back to template lines', async () => {
  resetLlmBudget();
  updateSettings({ ai: { ...getSettings().ai!, features: { ...getSettings().ai!.features, dj: false } } });
  calls = 0;
  assert.equal(llmAvailable('dj'), false);
  assert.equal(await djChat('sys', 'hi'), null);
  assert.equal(llmAvailable('ask'), true);
  assert.equal(calls, 0);
  // The DJ itself is still enabled (its own switch) — only the model is off for it.
  assert.equal(getSettings().aiDj.enabled, true);
  updateSettings({ ai: { ...getSettings().ai!, features: { ...getSettings().ai!.features, dj: true } } });
});

test("provider 'none': every feature degrades quietly", async () => {
  updateSettings({ ai: { ...getSettings().ai!, llm: { ...getSettings().ai!.llm, provider: 'none' } } });
  calls = 0;
  assert.equal(llmConfigured(), false);
  for (const f of ['dj', 'ask', 'recaps', 'autoSubtitles'] as const) assert.equal(llmAvailable(f), false);
  assert.equal(await llmChat('s', 'u', { feature: 'ask' }), null);
  assert.equal(await djChat('s', 'u'), null);
  assert.equal(getSettings().aiDj.llm.provider, 'none');
  assert.equal(calls, 0);
  // The DJ host still talks (template), even for an unknown track it simply says nothing.
  const line = await hostLine({ id: 'nobody', username: 'x', isAdmin: true } as never, { nextItemId: 'missing', position: 0 } as never);
  assert.equal(line.by, 'template');
});
