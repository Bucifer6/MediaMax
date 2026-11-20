import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePromptRules } from '../src/services/dj/ai.ts';
import { similarity, timbre } from '../src/services/dj/dsp.ts';

const LIB = ['House', 'Deep House', 'Techno', 'Hip Hop', 'Jazz', 'Rock', 'Indie Rock', 'Soul', 'R&B', 'Ambient', 'Pop'];

test('genres from names and synonyms', () => {
  assert.deepEqual(parsePromptRules('some deep house please', LIB).request.genres?.sort(), ['Deep House', 'House']);
  const edm = parsePromptRules('EDM for the drive', LIB).request.genres ?? [];
  assert.ok(edm.includes('House') && edm.includes('Techno'), edm.join());
  assert.ok((parsePromptRules('rnb and soul', LIB).request.genres ?? []).includes('R&B'));
  assert.deepEqual(parsePromptRules('hiphop', LIB).request.genres, ['Hip Hop']);
});

test('decades and years', () => {
  let r = parsePromptRules('chilled 90s house', LIB).request;
  assert.equal(r.yearFrom, 1990);
  assert.equal(r.yearTo, 1999);
  r = parsePromptRules('the eighties', LIB).request;
  assert.equal(r.yearFrom, 1980);
  r = parsePromptRules('2010s pop', LIB).request;
  assert.deepEqual([r.yearFrom, r.yearTo], [2010, 2019]);
  r = parsePromptRules('anything since 2015', LIB).request;
  assert.deepEqual([r.yearFrom, r.yearTo], [2015, undefined]);
});

test('mood, tempo and length', () => {
  const chill = parsePromptRules('something mellow for a lazy Sunday morning', LIB);
  assert.equal(chill.request.curve, 'chill');
  const run = parsePromptRules('high energy workout, 45 minutes', LIB);
  assert.equal(run.request.curve, 'build');
  assert.equal(run.request.durationMin, 45);
  assert.ok((run.request.bpmMin ?? 0) >= 118);
  const party = parsePromptRules('party bangers all night', LIB);
  assert.equal(party.request.curve, 'peak');
  assert.equal(party.continuous, true);
  const bpm = parsePromptRules('house around 124 bpm for 2 hours', LIB).request;
  assert.deepEqual([bpm.bpmMin, bpm.bpmMax, bpm.durationMin], [120, 128, 120]);
  assert.equal(parsePromptRules('rock, nothing over 5 minutes', LIB).request.maxTrackMinutes, 5);
});

test('seed names and summary', () => {
  const p = parsePromptRules('something like Daft Punk but chill', LIB);
  assert.equal(p.seedName, 'Daft Punk');
  assert.match(p.summary, /chill/);
  assert.equal(parsePromptRules('start with Bohemian Rhapsody, then rock', LIB).seedName, 'Bohemian Rhapsody');
  assert.equal(parsePromptRules('surprise me', LIB).summary, 'A mix from your library');
});

test('timbre: similar sounds are closer than different ones', () => {
  const R = 11025;
  const tone = (fn: (t: number) => number) => Float32Array.from({ length: R * 20 }, (_, i) => fn(i / R));
  const bright1 = timbre(tone((t) => 0.3 * Math.sign(Math.sin(2 * Math.PI * 440 * t))), R)!; // square wave: lots of harmonics
  const bright2 = timbre(tone((t) => 0.3 * Math.sign(Math.sin(2 * Math.PI * 523 * t))), R)!;
  const dull = timbre(tone((t) => 0.3 * Math.sin(2 * Math.PI * 110 * t)), R)!; // pure low sine
  const noise = timbre(tone(() => 0.2 * (Math.random() - 0.5)), R)!;
  const all = [bright1, bright2, dull, noise];
  const mean = bright1.map((_, i) => all.reduce((s, v) => s + v[i], 0) / all.length);
  const std = bright1.map((_, i) => Math.sqrt(all.reduce((s, v) => s + (v[i] - mean[i]) ** 2, 0) / all.length));
  assert.equal(bright1.length, 26);
  assert.ok(similarity(bright1, bright2, mean, std) > similarity(bright1, dull, mean, std));
  assert.ok(similarity(bright1, bright2, mean, std) > similarity(bright1, noise, mean, std));
});

import { openaiUrl } from '../src/services/dj/ai.ts';
test('OpenAI-compatible base URLs from popular free/cheap providers', () => {
  const c = (b: string) => openaiUrl(b, 'chat/completions');
  assert.equal(c('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(c('https://generativelanguage.googleapis.com/v1beta/openai/'), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(c('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(c('https://api.mistral.ai/v1'), 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(c('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(c('http://localhost:1234'), 'http://localhost:1234/v1/chat/completions'); // LM Studio
  assert.equal(c('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(openaiUrl('http://nas:8880/v1', 'audio/speech'), 'http://nas:8880/v1/audio/speech'); // Kokoro-FastAPI
});
