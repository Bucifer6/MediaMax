/**
 * Cue-by-cue subtitle translation with the shared language model. Cues go in numbered batches; timing never leaves
 * the server (only text is sent), so the result always has exactly the same cues and timestamps. A batch whose reply
 * doesn't line up is retried in halves, and a single cue that still fails stops the job (better no subtitle than a
 * half-translated one labelled with the wrong language).
 */
import type { Cue } from './srt.js';
import { extractJson, llmChat } from '../ai/llm.js';
import { fixRomanianDiacritics, isRomanian } from '../subtitleProviders/cleanup.js';

export type ChatFn = (system: string, user: string) => Promise<string | null>;

const NAMES: Record<string, string> = { en: 'English', ro: 'Romanian', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', hu: 'Hungarian', ru: 'Russian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', bg: 'Bulgarian', el: 'Greek', cs: 'Czech', sv: 'Swedish', uk: 'Ukrainian', sr: 'Serbian', hr: 'Croatian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese' };
export const languageName = (l: string | null) => (l ? NAMES[l] ?? l : 'the original language');

export function translationPrompt(from: string | null, to: string): string {
  const ro = to === 'ro'
    ? '\nWrite correct Romanian with full diacritics: ă â î ș ț (ș and ț with a comma below, never the cedilla forms ş ţ). Use natural spoken Romanian, informal "tu" between friends unless the scene is formal.'
    : '';
  return `You translate film subtitles from ${languageName(from)} to ${languageName(to)}.
You get JSON {"cues":[{"i":number,"t":string}]}. Reply with ONE JSON object {"cues":[{"i":number,"t":string}]} containing exactly the same "i" values in the same order, nothing else.
Rules: translate each cue on its own; keep it short enough to read on screen; keep line breaks ("\\n") where the original has them; keep names, numbers and song lyrics in brackets as they are; do not merge, split, add or drop cues; no notes, no explanations.${ro}`;
}

/** Same number of lines as the original cue (models sometimes drop or add a break). */
function matchLines(original: string, translated: string): string {
  const want = original.split('\n').length;
  const t = translated.replace(/\r/g, '').trim();
  const have = t.split('\n').length;
  if (have === want) return t;
  const flat = t.replace(/\s*\n\s*/g, ' ');
  if (want === 1) return flat;
  // Two-line original: break the translation near its middle at a space.
  const mid = Math.floor(flat.length / 2);
  let cut = flat.lastIndexOf(' ', mid);
  const after = flat.indexOf(' ', mid);
  if (cut < 0 || (after >= 0 && after - mid < mid - cut)) cut = after;
  return cut > 0 ? `${flat.slice(0, cut)}\n${flat.slice(cut + 1)}` : flat;
}

async function translateBatch(batch: { i: number; t: string }[], system: string, chat: ChatFn): Promise<Map<number, string> | null> {
  const reply = await chat(system, JSON.stringify({ cues: batch }));
  const j = reply ? extractJson(reply) : null;
  const arr = Array.isArray(j?.cues) ? (j!.cues as unknown[]) : null;
  if (!arr || arr.length !== batch.length) return null;
  const out = new Map<number, string>();
  for (let k = 0; k < arr.length; k++) {
    const x = arr[k] as { i?: unknown; t?: unknown };
    if (Number(x?.i) !== batch[k].i || typeof x.t !== 'string' || !x.t.trim()) return null;
    out.set(batch[k].i, x.t);
  }
  return out;
}

export interface TranslateOptions {
  batchSize?: number;
  chat?: ChatFn;
  onProgress?: (done: number, total: number) => void;
}

/** Translate cue texts from `from` to `to`, keeping every cue's timing. Throws when the model can't be used. */
export async function translateCues(cues: Cue[], from: string | null, to: string, opts: TranslateOptions = {}): Promise<Cue[]> {
  const chat: ChatFn = opts.chat ?? ((s, u) => llmChat(s, u, { feature: 'autoSubtitles', json: true, temperature: 0.2, maxTokens: 4000, timeoutMs: 120000 }));
  const size = Math.max(1, Math.min(60, opts.batchSize ?? 25));
  const system = translationPrompt(from, to);
  const result = new Map<number, string>();
  const run = async (batch: { i: number; t: string }[]): Promise<void> => {
    const got = await translateBatch(batch, system, chat);
    if (got) {
      for (const [i, t] of got) result.set(i, t);
      return;
    }
    if (batch.length === 1) throw new Error(`The language model did not translate cue ${batch[0].i + 1}`);
    const half = Math.ceil(batch.length / 2);
    await run(batch.slice(0, half));
    await run(batch.slice(half));
  };
  const items = cues.map((c, i) => ({ i, t: c.text }));
  for (let k = 0; k < items.length; k += size) {
    await run(items.slice(k, k + size));
    opts.onProgress?.(Math.min(items.length, k + size), items.length);
  }
  return cues.map((c, i) => {
    let t = matchLines(c.text, result.get(i) ?? c.text);
    if (isRomanian(to)) t = fixRomanianDiacritics(t);
    return { startMs: c.startMs, endMs: c.endMs, text: t };
  });
}
