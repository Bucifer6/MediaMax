import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactRules, healthTone, LLM_PRESETS, llmFromPreset, moveItem, TTS_PRESETS, ttsFromPreset } from '../src/admin/aiChain';

test('presets cover local, free-tier and paid providers of every kind', () => {
  const groups = new Set(LLM_PRESETS.map((p) => p.group));
  assert.deepEqual([...groups].sort(), ['free', 'local', 'paid']);
  for (const id of ['ollama', 'lmstudio', 'llamacpp', 'localai', 'groq', 'gemini', 'anthropic', 'gemini-paid', 'openai', 'deepseek']) assert.ok(LLM_PRESETS.some((p) => p.id === id), id);
  assert.equal(LLM_PRESETS.find((p) => p.id === 'anthropic')!.kind, 'anthropic');
  assert.ok(TTS_PRESETS.some((p) => p.patch.kind === 'elevenlabs'));
  const paid = llmFromPreset(LLM_PRESETS.find((p) => p.id === 'openai')!);
  assert.equal(paid.paid, true);
  assert.ok((paid.dailyCap ?? 0) > 0, 'paid providers start with a daily cap');
  assert.equal(llmFromPreset(LLM_PRESETS[0]).paid, false);
  assert.notEqual(llmFromPreset(LLM_PRESETS[0]).id, llmFromPreset(LLM_PRESETS[0]).id, 'unique ids');
  assert.equal(ttsFromPreset(TTS_PRESETS[0]).enabled, true);
});

test('reorder and health dots', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
  const base = { id: 'x', kind: 'llm' as const, name: 'X', calls24h: 0, callsToday: 0 };
  assert.equal(healthTone({ enabled: false }, { ...base, ok: true }), 'idle');
  assert.equal(healthTone({ enabled: true }, undefined), 'idle');
  assert.equal(healthTone({ enabled: true }, { ...base, ok: true, lastUsedAt: new Date().toISOString() }), 'ok');
  assert.equal(healthTone({ enabled: true }, { ...base, ok: false, lastError: 'HTTP 500', cooldownUntil: new Date(Date.now() + 60000).toISOString() }), 'cooling');
  assert.equal(healthTone({ enabled: true }, { ...base, ok: false, lastError: 'HTTP 401' }), 'error');
});

test('DJ restrictions: empty fields are dropped so {} means none', () => {
  assert.deepEqual(compactRules({ includeGenres: [], cleanOnly: false, yearMin: undefined, maxDurationSec: 300, excludeArtists: ['X'] }), { maxDurationSec: 300, excludeArtists: ['X'] });
  assert.deepEqual(compactRules({}), {});
});
