/**
 * Helper programs (Piper, whisper.cpp, comskip) come only from the environment, never from web settings, and the AI
 * provider URL helpers stay fast on hostile input (CodeQL js/command-line-injection and js/polynomial-redos).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AutoSubtitleSettings } from '@mediamax/shared';
import { config } from '../src/config.ts';
import { anthropicUrl, geminiUrl, openaiUrl, trimTrailingSlashes } from '../src/services/ai/llm.ts';
import { resolveWhisperBinary } from '../src/services/autosubs/engine.ts';

test('trimTrailingSlashes drops only trailing slashes', () => {
  assert.equal(trimTrailingSlashes('http://a/v1///'), 'http://a/v1');
  assert.equal(trimTrailingSlashes('http://a/v1'), 'http://a/v1');
  assert.equal(trimTrailingSlashes('///'), '');
  assert.equal(trimTrailingSlashes(''), '');
});

test('provider URL helpers give the same endpoints as before', () => {
  assert.equal(anthropicUrl('https://api.anthropic.com/'), 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropicUrl('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1/messages');
  assert.equal(geminiUrl('', 'gemini-2.0-flash'), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
  assert.equal(geminiUrl('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent', 'models/y'),
    'https://generativelanguage.googleapis.com/v1beta/models/y:generateContent');
  assert.equal(geminiUrl('https://generativelanguage.googleapis.com/v1beta/openai/', 'y'), 'https://generativelanguage.googleapis.com/v1beta/models/y:generateContent');
  assert.equal(openaiUrl('https://api.example.com/v2beta//', 'embeddings'), 'https://api.example.com/v2beta/embeddings');
  assert.equal(openaiUrl('https://api.example.com/version', 'embeddings'), 'https://api.example.com/version/v1/embeddings');
});

test('provider URL helpers stay fast on input built to make regexes backtrack', () => {
  const n = 50_000;
  const inputs = ['/'.repeat(n) + 'x', '/v' + '0'.repeat(n) + '!', '/models/'.repeat(n / 8) + 'x'];
  const t = performance.now();
  for (const s of inputs) {
    openaiUrl(s, 'chat/completions');
    anthropicUrl(s);
    geminiUrl(s, 'm');
  }
  assert.ok(performance.now() - t < 500, `took ${Math.round(performance.now() - t)} ms`);
});

test('helper programs default to their names on the PATH', () => {
  assert.equal(config.piper, process.env.MEDIAMAX_PIPER || 'piper');
  assert.equal(config.comskip, process.env.MEDIAMAX_COMSKIP || 'comskip');
});

test('a whisper.cpp path saved in the web settings is not used; VIBE_WHISPER is', () => {
  const saved = process.env.MEDIAMAX_WHISPER;
  try {
    delete process.env.MEDIAMAX_WHISPER;
    // process.execPath exists, so the old code would have returned it as "the whisper program".
    const s = { whisperPath: process.execPath } as unknown as AutoSubtitleSettings;
    assert.notEqual(resolveWhisperBinary(s), process.execPath);
    process.env.MEDIAMAX_WHISPER = process.execPath;
    assert.equal(resolveWhisperBinary({ whisperPath: null } as unknown as AutoSubtitleSettings), process.execPath);
  } finally {
    if (saved === undefined) delete process.env.MEDIAMAX_WHISPER;
    else process.env.MEDIAMAX_WHISPER = saved;
  }
});
