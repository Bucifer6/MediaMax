/**
 * Automatic subtitles, the pure parts: whisper.cpp command lines, its JSON output → cues (with chunk offsets),
 * OpenAI-style verbose_json → cues, silence-based chunk planning and SRT assembly. No I/O here (unit-tested).
 */

export interface Cue {
  startMs: number;
  endMs: number;
  /** May contain "\n" line breaks. */
  text: string;
}

export interface WhisperArgs {
  model: string;
  input: string;
  /** Output path without extension: whisper.cpp writes `<outBase>.json`. */
  outBase: string;
  /** ISO 639-1, or null/'auto' to let whisper detect it. */
  language: string | null;
  /** Translate to English (whisper's built-in translation). */
  translate?: boolean;
  threads?: number;
  /** Prompt with the previous chunk's last line, so names and style carry over. */
  prompt?: string | null;
}

/** Arguments for whisper.cpp's `whisper-cli` (also the older `main`): JSON output, no console transcript. */
export function buildWhisperArgs(a: WhisperArgs): string[] {
  const args = ['-m', a.model, '-f', a.input, '-oj', '-of', a.outBase, '-np', '-l', a.language && a.language !== 'auto' ? a.language : 'auto'];
  if (a.threads && a.threads > 0) args.push('-t', String(Math.round(a.threads)));
  if (a.translate) args.push('-tr');
  // Split long segments at word boundaries so cues stay readable (≈ two subtitle lines).
  args.push('-ml', '84', '-sow');
  if (a.prompt) args.push('--prompt', a.prompt.slice(0, 200));
  return args;
}

/** "00:01:02,345" / "00:01:02.345" → ms. */
export function parseTimestamp(t: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(t.trim());
  if (!m) return null;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0');
}

/** Lines whisper invents over silence or music; never real dialogue. */
const HALLUCINATION = /^(?:\[(?:BLANK_AUDIO|MUSIC|Music|SOUND|silence|Silence|NO SPEECH)[^\]]*\]|\((?:music|silence|no speech|inaudible)\)|♪+|\.+|-+|thank(?:s| you) for watching[.!]?|please subscribe[.!]?|subtitles? by .*|transcri(?:bed|ption) by .*|.*amara\.org.*|sous-titr.*|untertitel .*)$/i;

/** whisper.cpp `-oj` output → cues, shifted by `offsetMs` (the chunk's start in the film). */
export function parseWhisperJson(json: unknown, offsetMs = 0): { cues: Cue[]; language: string | null } {
  const j = (json ?? {}) as { transcription?: { timestamps?: { from?: string; to?: string }; offsets?: { from?: number; to?: number }; text?: string }[]; result?: { language?: string } };
  const cues: Cue[] = [];
  for (const seg of j.transcription ?? []) {
    const from = typeof seg.offsets?.from === 'number' ? seg.offsets.from : parseTimestamp(seg.timestamps?.from ?? '');
    const to = typeof seg.offsets?.to === 'number' ? seg.offsets.to : parseTimestamp(seg.timestamps?.to ?? '');
    const text = cleanCueText(seg.text ?? '');
    if (from == null || to == null || !text) continue;
    cues.push({ startMs: from + offsetMs, endMs: Math.max(to, from + 1) + offsetMs, text });
  }
  const language = typeof j.result?.language === 'string' && /^[a-z]{2,3}$/.test(j.result.language) ? j.result.language : null;
  return { cues, language };
}

/** OpenAI-compatible `response_format=verbose_json` (segments in seconds) → cues, shifted by `offsetMs`. */
export function parseVerboseJson(json: unknown, offsetMs = 0): { cues: Cue[]; language: string | null } {
  const j = (json ?? {}) as { segments?: { start?: number; end?: number; text?: string }[]; language?: string; text?: string; duration?: number };
  const cues: Cue[] = [];
  for (const s of j.segments ?? []) {
    const text = cleanCueText(s.text ?? '');
    if (typeof s.start !== 'number' || typeof s.end !== 'number' || !text) continue;
    cues.push({ startMs: Math.round(s.start * 1000) + offsetMs, endMs: Math.round(Math.max(s.end, s.start + 0.001) * 1000) + offsetMs, text });
  }
  if (!cues.length && j.text?.trim() && typeof j.duration === 'number') cues.push({ startMs: offsetMs, endMs: offsetMs + Math.round(j.duration * 1000), text: cleanCueText(j.text) });
  return { cues, language: normaliseLanguageName(j.language) };
}

const LANG_NAMES: Record<string, string> = { english: 'en', romanian: 'ro', moldavian: 'ro', french: 'fr', german: 'de', spanish: 'es', italian: 'it', hungarian: 'hu', russian: 'ru', portuguese: 'pt', dutch: 'nl', polish: 'pl', turkish: 'tr', japanese: 'ja', korean: 'ko', chinese: 'zh', swedish: 'sv', greek: 'el', czech: 'cs', bulgarian: 'bg', serbian: 'sr', croatian: 'hr', ukrainian: 'uk', arabic: 'ar', hindi: 'hi' };
/** "english" / "en" → "en" (APIs report either). */
export function normaliseLanguageName(l: string | null | undefined): string | null {
  if (!l) return null;
  const s = l.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(s)) return s;
  return LANG_NAMES[s] ?? null;
}

export function cleanCueText(t: string): string {
  const s = t.replace(/\s+/g, ' ').trim();
  if (!s || HALLUCINATION.test(s)) return '';
  return s;
}

/* ------------------------------ chunking ------------------------------ */

export interface Silence { startMs: number; endMs: number }
export interface Chunk { index: number; startMs: number; endMs: number }

/** ffmpeg `silencedetect` stderr → silences. An unterminated trailing silence runs to `durationMs`. */
export function parseSilences(stderr: string, durationMs?: number): Silence[] {
  const out: Silence[] = [];
  let start: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    let m = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (m) {
      start = Math.max(0, Math.round(parseFloat(m[1]) * 1000));
      continue;
    }
    m = /silence_end:\s*([\d.]+)/.exec(line);
    if (m && start != null) {
      out.push({ startMs: start, endMs: Math.round(parseFloat(m[1]) * 1000) });
      start = null;
    }
  }
  if (start != null && durationMs != null && durationMs > start) out.push({ startMs: start, endMs: durationMs });
  return out;
}

/**
 * Split a film into chunks of about `targetMs`, cutting in the middle of a silence near each target (never mid-word),
 * never longer than `maxMs` (a hard cut when no silence is near). Long silences are skipped entirely: a chunk that is
 * wholly silent is dropped, which also stops whisper from hallucinating over it.
 */
export function planChunks(durationMs: number, silences: Silence[], targetMs = 5 * 60_000, maxMs = 8 * 60_000, minMs = 30_000): Chunk[] {
  const sil = [...silences].filter((s) => s.endMs > s.startMs).sort((a, b) => a.startMs - b.startMs);
  const cuts: number[] = [];
  let pos = 0;
  while (durationMs - pos > maxMs) {
    const lo = pos + minMs;
    const hi = pos + maxMs;
    const target = pos + targetMs;
    // Silence whose middle lies in (lo, hi], closest to the target; longer silences win ties.
    let best: number | null = null;
    let bestScore = Infinity;
    for (const s of sil) {
      const mid = Math.round((s.startMs + s.endMs) / 2);
      if (mid <= lo || mid > hi) continue;
      const score = Math.abs(mid - target) - Math.min(2000, s.endMs - s.startMs);
      if (score < bestScore) {
        bestScore = score;
        best = mid;
      }
    }
    const cut = best ?? hi;
    cuts.push(cut);
    pos = cut;
  }
  const bounds = [0, ...cuts, durationMs];
  const chunks: Chunk[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let start = bounds[i];
    let end = bounds[i + 1];
    // Trim silence at the edges so whisper starts on speech (keeps 200 ms of air).
    for (const s of sil) {
      if (s.startMs <= start + 50 && s.endMs > start && s.endMs < end) start = Math.max(start, s.endMs - 200);
      if (s.endMs >= end - 50 && s.startMs < end && s.startMs > start) end = Math.min(end, s.startMs + 200);
    }
    if (end - start < 300) continue;
    // Wholly inside one silence: nothing to transcribe.
    if (sil.some((s) => s.startMs <= start && s.endMs >= end)) continue;
    chunks.push({ index: chunks.length, startMs: start, endMs: end });
  }
  return chunks;
}

/* ------------------------------ SRT ------------------------------ */

export function srtTime(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3600000);
  const m = Math.floor((v % 3600000) / 60000);
  const s = Math.floor((v % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(v % 1000).padStart(3, '0')}`;
}

/** Break one line into at most two balanced lines of ≤ `max` characters (existing breaks are kept). */
export function wrapCue(text: string, max = 42): string {
  if (text.includes('\n') || text.length <= max) return text;
  const words = text.split(' ');
  let best = text;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const diff = Math.abs(a.length - b.length) + (Math.max(a.length, b.length) > max ? 1000 : 0);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

/**
 * Tidy cues for display: time order, no overlaps, at least 0.7 s and at most 7 s on screen, consecutive repeats
 * (a classic whisper loop) collapsed, empty text dropped.
 */
export function tidyCues(input: Cue[]): Cue[] {
  const cues = input.filter((c) => c.text.trim()).map((c) => ({ ...c, text: c.text.trim() })).sort((a, b) => a.startMs - b.startMs);
  const out: Cue[] = [];
  let repeat = 0;
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.text.toLowerCase() === c.text.toLowerCase()) {
      repeat++;
      if (repeat >= 1 && c.startMs - prev.endMs < 1500) {
        prev.endMs = Math.max(prev.endMs, c.endMs);
        continue;
      }
    } else repeat = 0;
    out.push({ ...c });
  }
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    const next = out[i + 1];
    if (c.endMs - c.startMs < 700) c.endMs = c.startMs + 700;
    if (c.endMs - c.startMs > 7000) c.endMs = c.startMs + 7000;
    if (next && c.endMs > next.startMs - 40) c.endMs = Math.max(c.startMs + 200, next.startMs - 40);
  }
  return out;
}

/** Cues → SRT text (1-based numbering, "\n" line endings, lines wrapped for reading). */
export function assembleSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${wrapCue(c.text)}\n`).join('\n');
}

/** Minimal SRT reader (used to resume and in tests). */
export function parseSrt(text: string): Cue[] {
  const out: Cue[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->').map((x) => parseTimestamp(x.trim().split(' ')[0]));
    if (a == null || b == null) continue;
    out.push({ startMs: a, endMs: b, text: lines.slice(ti + 1).join('\n') });
  }
  return out;
}
