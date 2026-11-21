// Automatic subtitles: whisper.cpp command lines, its JSON → cues/SRT, silence chunking and offsets, LLM translation
// batching (stub OpenAI-compatible server), the resumable job pipeline with fake ffmpeg/whisper, and the night window.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { buildWhisperArgs, parseWhisperJson, parseVerboseJson, parseSilences, planChunks, assembleSrt, parseSrt, tidyCues, wrapCue, srtTime } = await import('../src/services/autosubs/srt.ts');
const { translateCues } = await import('../src/services/autosubs/translate.ts');
const { pickAudioStream } = await import('../src/services/autosubs/audio.ts');
const { inWindow, enqueue, processJob, getJob, enqueueMissing, AI_LABEL } = await import('../src/services/autosubs/queue.ts');
const { releaseAssetName } = await import('../src/services/autosubs/engine.ts');
const { db } = await import('../src/db.ts');
const { getSettings, updateSettings } = await import('../src/services/settings.ts');
const { resetLlmBudget } = await import('../src/services/ai/llm.ts');
type Cue = import('../src/services/autosubs/srt.ts').Cue;
type PipelineDeps = import('../src/services/autosubs/queue.ts').PipelineDeps;

/* ------------------------------ whisper.cpp ------------------------------ */

test('whisper.cpp command: model, input, JSON output, language, threads, translate', () => {
  const a = buildWhisperArgs({ model: '/m/ggml-base.bin', input: '/w/chunk-0.wav', outBase: '/w/chunk-0', language: 'en', threads: 4 });
  assert.deepEqual(a.slice(0, 10), ['-m', '/m/ggml-base.bin', '-f', '/w/chunk-0.wav', '-oj', '-of', '/w/chunk-0', '-np', '-l', 'en']);
  assert.ok(a.includes('-t') && a[a.indexOf('-t') + 1] === '4');
  assert.ok(!a.includes('-tr'));
  const b = buildWhisperArgs({ model: 'm', input: 'i.wav', outBase: 'o', language: null, translate: true, prompt: 'Hello there.' });
  assert.equal(b[b.indexOf('-l') + 1], 'auto');
  assert.ok(b.includes('-tr'), 'built-in translation to English');
  assert.equal(b[b.indexOf('--prompt') + 1], 'Hello there.');
  assert.ok(!b.includes('-t'), 'threads omitted when not set');
});

const FAKE_WHISPER = {
  systeminfo: 'AVX2 = 1',
  model: { type: 'base' },
  result: { language: 'en' },
  transcription: [
    { timestamps: { from: '00:00:00,000', to: '00:00:02,500' }, offsets: { from: 0, to: 2500 }, text: ' Where were you last night?' },
    { timestamps: { from: '00:00:02,500', to: '00:00:04,000' }, offsets: { from: 2500, to: 4000 }, text: ' [BLANK_AUDIO]' },
    { timestamps: { from: '00:00:04,000', to: '00:00:07,250' }, offsets: { from: 4000, to: 7250 }, text: '  I was at the  bank, with Mr. Ionescu.' },
    { timestamps: { from: '00:00:07,250', to: '00:00:09,000' }, text: ' Thank you for watching!' },
    { timestamps: { from: '00:00:09,000', to: '00:00:11,000' }, text: ' Fine.' },
  ],
};

test('whisper JSON → cues: offsets added, hallucinations and blanks dropped, timestamps fallback', () => {
  const { cues, language } = parseWhisperJson(FAKE_WHISPER, 300_000);
  assert.equal(language, 'en');
  assert.deepEqual(cues, [
    { startMs: 300_000, endMs: 302_500, text: 'Where were you last night?' },
    { startMs: 304_000, endMs: 307_250, text: 'I was at the bank, with Mr. Ionescu.' },
    { startMs: 309_000, endMs: 311_000, text: 'Fine.' },
  ]);
});

test('SRT assembly: numbering, comma milliseconds, wrapping, tidy timing; round-trips', () => {
  const cues = tidyCues([
    { startMs: 3_723_004, endMs: 3_723_100, text: 'Short' },
    { startMs: 3_723_500, endMs: 3_740_000, text: 'This sentence is definitely longer than forty-two characters' },
    { startMs: 3_741_000, endMs: 3_742_000, text: 'Again' },
    { startMs: 3_742_200, endMs: 3_743_000, text: 'again' },
  ]);
  assert.equal(cues.length, 3, 'consecutive repeats collapse');
  assert.equal(cues[0].endMs - cues[0].startMs, 456 /* min 0.7 s, but ends 40 ms before the next cue */);
  assert.ok(cues[1].endMs - cues[1].startMs <= 7000, 'at most 7 s on screen');
  const srt = assembleSrt(cues);
  assert.match(srt, /^1\n01:02:03,004 --> 01:02:03,460\nShort\n\n2\n01:02:03,500 --> /);
  assert.ok(srt.includes('This sentence is definitely\nlonger than forty-two characters') || srt.includes('This sentence is definitely longer\nthan forty-two characters'));
  const back = parseSrt(srt);
  assert.equal(back.length, 3);
  assert.equal(back[2].startMs, 3_741_000);
  assert.equal(srtTime(59_999), '00:00:59,999');
  assert.equal(wrapCue('Hi there'), 'Hi there');
});

test('OpenAI verbose_json (faster-whisper servers) → cues with offset and language names', () => {
  const r = parseVerboseJson({ language: 'romanian', segments: [{ start: 1.2, end: 3.45, text: ' Bună ziua! ' }, { start: 4, end: 5, text: '♪♪' }] }, 60_000);
  assert.equal(r.language, 'ro');
  assert.deepEqual(r.cues, [{ startMs: 61_200, endMs: 63_450, text: 'Bună ziua!' }]);
});

/* ------------------------------ chunking ------------------------------ */

test('silencedetect output parses, including an unterminated trailing silence', () => {
  const stderr = `[silencedetect @ 0x1] silence_start: 12.5\n[silencedetect @ 0x1] silence_end: 14.25 | silence_duration: 1.75\nsize=N/A\n[silencedetect @ 0x1] silence_start: 590.1`;
  assert.deepEqual(parseSilences(stderr, 600_000), [{ startMs: 12_500, endMs: 14_250 }, { startMs: 590_100, endMs: 600_000 }]);
});

test('chunks cut inside silences near the target length, cover the speech, and offsets stay absolute', () => {
  const dur = 20 * 60_000;
  const silences = [{ startMs: 4 * 60_000 + 50_000, endMs: 4 * 60_000 + 52_000 }, { startMs: 10 * 60_000, endMs: 10 * 60_000 + 3000 }, { startMs: 15 * 60_000 + 1000, endMs: 15 * 60_000 + 2000 }];
  const chunks = planChunks(dur, silences);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.endMs - c.startMs <= 8 * 60_000 + 1, 'never longer than the maximum');
  // Every internal cut lies within a silence (never mid-word).
  for (let i = 0; i < chunks.length - 1; i++) {
    const cut = chunks[i].endMs;
    assert.ok(silences.some((s) => cut >= s.startMs && cut <= s.endMs + 200), `cut at ${cut} is in a silence`);
  }
  assert.equal(chunks[0].startMs, 0);
  assert.equal(chunks.at(-1)!.endMs, dur);
  // No silence near: hard cuts at the maximum.
  const hard = planChunks(20 * 60_000, []);
  assert.deepEqual(hard.map((c) => c.startMs), [0, 8 * 60_000, 16 * 60_000]);
  // A whisper chunk's local times map back to film time by the chunk start.
  const c2 = chunks[1];
  const { cues } = parseWhisperJson({ transcription: [{ offsets: { from: 1000, to: 2000 }, text: 'Hi' }] }, c2.startMs);
  assert.equal(cues[0].startMs, c2.startMs + 1000);
  // A wholly silent stretch is skipped.
  const silentEnd = planChunks(10 * 60_000, [{ startMs: 8 * 60_000 + 10_000, endMs: 10 * 60_000 }]);
  assert.ok(silentEnd.every((c) => c.endMs <= 8 * 60_000 + 10_200));
});

test('the dialogue track: default, skipping commentary, preferring the original language', () => {
  const streams = [
    { index: 1, codec: 'ac3', language: 'rum', title: 'Dublaj', channels: 6, default: true },
    { index: 2, codec: 'aac', language: 'eng', title: null, channels: 2, default: false },
    { index: 3, codec: 'aac', language: 'eng', title: "Director's commentary", channels: 2, default: false },
  ];
  assert.deepEqual(pickAudioStream(streams), { ordinal: 0, language: 'ro' });
  assert.deepEqual(pickAudioStream(streams, 'en'), { ordinal: 1, language: 'en' });
  assert.deepEqual(pickAudioStream([{ index: 1, codec: 'aac', language: 'und', title: 'Commentary', channels: 2, default: true }]), { ordinal: 0, language: null });
  assert.equal(pickAudioStream([]), null);
});

test('night window, including across midnight', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 21, h, m);
  assert.ok(inWindow('01:00', '07:00', at(3)));
  assert.ok(!inWindow('01:00', '07:00', at(7)));
  assert.ok(inWindow('23:00', '06:00', at(23, 30)));
  assert.ok(inWindow('23:00', '06:00', at(2)));
  assert.ok(!inWindow('23:00', '06:00', at(12)));
  assert.ok(inWindow('00:00', '00:00', at(15)), 'equal ends = any time');
});

test('one-click whisper.cpp download only exists for Windows (official release assets)', () => {
  assert.equal(releaseAssetName('win32', 'x64'), 'whisper-bin-x64.zip');
  assert.equal(releaseAssetName('linux', 'x64'), null);
});

/* ------------------------------ translation ------------------------------ */

let llmCalls: { cues: { i: number; t: string }[] }[] = [];
let breakNext = false;
const ro: Record<string, string> = {
  'Where were you last night?': 'Unde ai fost aseară?',
  'I was at the bank,\nwith Mr. Ionescu.': 'Am fost la bancă,\ncu domnul Ionescu.',
  'Fine.': 'Bine. Şi ţie.',
};
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = JSON.parse(body);
    const user = JSON.parse(j.messages[1].content) as { cues: { i: number; t: string }[] };
    llmCalls.push(user);
    let cues = user.cues.map((c) => ({ i: c.i, t: ro[c.t] ?? `RO:${c.t}`.replace(/\n/g, ' ') }));
    // A model that drops a cue on the first big batch: the batch must be retried in halves.
    if (breakNext && cues.length > 1) {
      breakNext = false;
      cues = cues.slice(1);
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Sure! ```json\n' + JSON.stringify({ cues }) + '\n```' } }] }));
  });
});
await new Promise<void>((r) => llm.listen(0, '127.0.0.1', () => r()));
after(() => llm.close());
const llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
updateSettings({ ai: { ...getSettings().ai!, llm: { provider: 'openai', url: llmUrl, model: 'stub', apiKey: null, maxRequestsPerDay: 0 }, features: { ...getSettings().ai!.features, autoSubtitles: true } } });

test('translation batching keeps every cue, its timing and its line breaks (and Romanian comma-below)', async () => {
  resetLlmBudget();
  llmCalls = [];
  breakNext = true;
  const cues: Cue[] = [
    { startMs: 1000, endMs: 2500, text: 'Where were you last night?' },
    { startMs: 3000, endMs: 5000, text: 'I was at the bank,\nwith Mr. Ionescu.' },
    { startMs: 5200, endMs: 6000, text: 'Fine.' },
    ...Array.from({ length: 30 }, (_, k) => ({ startMs: 10_000 + k * 2000, endMs: 11_500 + k * 2000, text: k % 2 ? `Line ${k}\nsecond part` : `Line ${k}` })),
  ];
  const progress: number[] = [];
  const out = await translateCues(cues, 'en', 'ro', { batchSize: 10, onProgress: (d) => progress.push(d) });
  assert.equal(out.length, cues.length);
  out.forEach((c, i) => {
    assert.equal(c.startMs, cues[i].startMs);
    assert.equal(c.endMs, cues[i].endMs);
    assert.equal(c.text.split('\n').length, cues[i].text.split('\n').length, `cue ${i} keeps its line count`);
  });
  assert.equal(out[0].text, 'Unde ai fost aseară?');
  assert.equal(out[1].text, 'Am fost la bancă,\ncu domnul Ionescu.');
  assert.equal(out[2].text, 'Bine. Și ție.', 'cedilla ş ţ → comma-below ș ț');
  assert.ok(llmCalls.every((c) => c.cues.length <= 10), 'batches of at most 10');
  assert.ok(llmCalls.some((c) => c.cues.length === 5), 'the broken batch was retried in halves');
  assert.ok(!JSON.stringify(llmCalls).includes('10000'), 'timing never leaves the server');
  assert.deepEqual(progress, [10, 20, 30, 33]);
});

test('translation fails loudly when no model is available (no half-translated file)', async () => {
  await assert.rejects(translateCues([{ startMs: 0, endMs: 1000, text: 'Hi' }], 'en', 'ro', { chat: async () => null }), /did not translate/);
});

/* ------------------------------ the job pipeline ------------------------------ */

const now = new Date().toISOString();
const old = new Date(Date.now() - 3 * 86400_000).toISOString();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-autosub-'));
const video = path.join(tmp, 'Film.2019.mkv');
fs.writeFileSync(video, 'not really a video');
db.insert('libraries', { id: 'as-lib', name: 'Movies', type: 'movies', paths: JSON.stringify([tmp]), created_at: now });
db.insert('items', { id: 'as-film', library_id: 'as-lib', type: 'movie', title: 'Film', sort_title: 'Film', year: 2019, added_at: old, updated_at: now });
db.insert('media', { id: 'as-media', item_id: 'as-film', path: video, duration_ms: 1_200_000, audio: JSON.stringify([{ index: 1, codec: 'aac', language: 'eng', title: null, channels: 2, default: true }]), subs: '[]' });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeDeps(over: Partial<PipelineDeps> = {}) {
  const log: string[] = [];
  const deps: PipelineDeps = {
    extract: async (_in, ordinal, out) => {
      log.push(`extract:${ordinal}`);
      fs.writeFileSync(out, Buffer.alloc(44));
    },
    duration: () => 20 * 60_000,
    silences: async () => [{ startMs: 299_000, endMs: 301_000 }, { startMs: 599_000, endMs: 601_000 }, { startMs: 899_000, endMs: 901_000 }],
    cut: async (_wav, s, e, out) => {
      log.push(`cut:${s}-${e}`);
      fs.writeFileSync(out, Buffer.alloc(44));
    },
    transcribe: async (r) => {
      log.push(`transcribe:${r.offsetMs}:${r.language}:${r.translateToEnglish}`);
      return parseWhisperJson({ result: { language: 'en' }, transcription: [{ offsets: { from: 500, to: 2500 }, text: `Hello at ${r.offsetMs}` }, { offsets: { from: 3000, to: 4000 }, text: 'Fine.' }] }, r.offsetMs);
    },
    translate: (cues, from, to, onProgress) => translateCues(cues, from, to, { onProgress }),
    canTranslate: () => true,
    keepGoing: () => true,
    ...over,
  };
  return { deps, log };
}

test('a job: extract → chunks → whisper (offsets) → LLM translation → SRT saved as "Auto-generated (AI)", resumable', async () => {
  resetLlmBudget();
  const job = enqueue('as-film', 'ro');
  assert.equal(job.status, 'queued');
  // First night: dawn comes after two chunks.
  let chunksDone = 0;
  const first = fakeDeps({ keepGoing: () => chunksDone++ < 2 });
  assert.equal(await processJob(job.id, first.deps), 'paused');
  assert.equal(getJob(job.id)!.status, 'queued');
  assert.equal(first.log.filter((l) => l.startsWith('transcribe')).length, 2);
  // Next night: the audio is not extracted again and only the remaining chunks are transcribed.
  const second = fakeDeps();
  assert.equal(await processJob(job.id, second.deps), 'done');
  assert.ok(!second.log.some((l) => l.startsWith('extract')), 'audio reused');
  const offsets = second.log.filter((l) => l.startsWith('transcribe')).map((l) => Number(l.split(':')[1]));
  assert.equal(offsets.length, 2);
  assert.ok(offsets.every((o) => o >= 599_000), 'resumed at the third chunk');
  assert.ok(second.log.every((l) => !l.startsWith('transcribe') || l.endsWith(':en:false')), 'transcribed in English, translated by the model');
  const done = getJob(job.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.translated, true);
  assert.equal(done.spokenLanguage, 'en');
  assert.equal(done.cues, 8);
  // Saved through the subtitle storage with the AI label and language.
  const subs = JSON.parse(db.get<{ subs: string }>('SELECT subs FROM media WHERE id = ?', 'as-media')!.subs);
  const ai = subs.find((s: { title: string }) => s.title === AI_LABEL);
  assert.ok(ai, 'listed with the "Auto-generated (AI)" label');
  assert.equal(ai.language, 'rum');
  assert.ok(ai.index >= 2000, 'listed after embedded and sidecar subtitles');
  const rec = db.get<{ path: string; provider: string }>('SELECT path, provider FROM subtitle_downloads WHERE media_id = ?', 'as-media')!;
  assert.equal(rec.provider, 'ai-whisper');
  const srt = parseSrt(fs.readFileSync(rec.path, 'utf8'));
  assert.equal(srt.length, 8);
  assert.equal(srt[0].startMs, 500);
  assert.ok(srt.some((c) => c.startMs === 599_000 + 500 || c.startMs === 600_200 + 500 || c.startMs > 599_000), 'later chunks keep absolute times');
  assert.ok(srt.every((c) => c.text.startsWith('RO:') || c.text === 'Bine. Și ție.'), 'every cue translated');
  // Now that a Romanian subtitle exists, the task does not queue the film again.
  db.run('DELETE FROM ai_subtitle_jobs');
  updateSettings({ ai: { ...getSettings().ai!, autoSubtitles: { ...getSettings().ai!.autoSubtitles, languages: ['ro'] } } });
  assert.equal(enqueueMissing(), 0);
});

test('English wanted from a French film uses whisper\'s own translation; no model → translation jobs are skipped', async () => {
  db.run('UPDATE media SET subs = ?, audio = ? WHERE id = ?', '[]', JSON.stringify([{ index: 1, codec: 'aac', language: 'fre', title: null, channels: 2, default: true }]), 'as-media');
  const en = enqueue('as-film', 'en');
  const a = fakeDeps({ canTranslate: () => false });
  assert.equal(await processJob(en.id, a.deps), 'done');
  assert.ok(a.log.filter((l) => l.startsWith('transcribe')).every((l) => l.endsWith(':fr:true')));
  // German wanted, no language model: skipped before hours of transcription are wasted.
  const de = enqueue('as-film', 'de');
  const b = fakeDeps({ canTranslate: () => false });
  assert.equal(await processJob(de.id, b.deps), 'skipped');
  assert.match(getJob(de.id)!.error!, /language model/);
  assert.equal(b.log.filter((l) => l.startsWith('transcribe')).length, 0);
});

test('the task queues only what is still missing, after the download task had its chance', () => {
  db.run('DELETE FROM ai_subtitle_jobs');
  db.run('UPDATE media SET subs = ? WHERE id = ?', JSON.stringify([{ index: 2, codec: 'subrip', language: 'eng', title: null, default: false, forced: false, external: false }]), 'as-media');
  updateSettings({ ai: { ...getSettings().ai!, autoSubtitles: { ...getSettings().ai!.autoSubtitles, languages: ['ro', 'en'] } } });
  assert.equal(enqueueMissing(), 1, 'English exists (embedded); Romanian is queued');
  assert.equal(enqueueMissing(), 0, 'not queued twice');
  db.insert('items', { id: 'as-new', library_id: 'as-lib', type: 'movie', title: 'New', sort_title: 'New', added_at: now, updated_at: now });
  db.insert('media', { id: 'as-new-m', item_id: 'as-new', path: path.join(tmp, 'new.mkv'), subs: '[]' });
  // Brand-new media waits only if a download provider could still find something; none is configured here.
  assert.equal(enqueueMissing(), 2);
});
