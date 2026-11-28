import fs from 'node:fs/promises';
import type { AutoSyncRequest, AutoSyncResponse, SubtitleSyncMap } from '@mediamax/shared';
import { db } from '../db.js';
import { badRequest, HttpError, notFound } from '../util/errors.js';
import { parseJson } from '../util/misc.js';
import { extractSubtitle, formatForCodec, isImageFormat } from './subtitles.js';
import { applySyncMap } from './playerPrefs.js';

/**
 * Subtitle AutoSync against a reference track: an out-of-sync subtitle (usually a downloaded sidecar) is lined up
 * with an embedded text track of the same file whose timing is right. Only the timing is compared, so the reference
 * may be in any language.
 *
 * Each track becomes a speech-occupancy signal (10 ms bins). The fit is the share of the reference's subtitle time
 * that the moved subtitle covers. It runs in three passes:
 *   1. constant delay + frame-rate drift: every common rate conversion (23.976 / 24 / 25 / 29.97 / 30) × a ±2 min
 *      offset search (100 ms steps, then refined to 10 ms);
 *   2. per-cue-group drift: cues are grouped at long gaps (ad breaks, cut scenes) and each group may move by up to
 *      ±3 s more when that clearly fits better;
 *   3. the result is a time map the players apply to cue times in place, so no stream restarts.
 */

type Span = [number, number];

const BIN = 10;
const COARSE = 100;
const MAX_OFFSET = 120_000;
const SAMPLE_CUES = 300;
const GROUP_GAP = 8_000;
const GROUP_MIN_CUES = 8;
const GROUP_RANGE = 3_000;
const FPS = [23.976, 24, 25, 29.97, 30];
/** Rate ratios: 1 first so ties keep the plain shift. */
const RATIOS = [1, ...FPS.flatMap((a) => FPS.filter((b) => b !== a).map((b) => a / b)).filter((r) => Math.abs(r - 1) > 0.0005)];

/** Cue times (ms) of a WebVTT file, sorted by start. Text is not needed. */
export function vttSpans(src: string): Span[] {
  const out: Span[] = [];
  const re = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/g;
  const ms = (h: string | undefined, m: string, s: string, f: string) => ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f.padEnd(3, '0'));
  for (const x of src.matchAll(re)) {
    const a = ms(x[1], x[2], x[3], x[4]);
    const b = ms(x[5], x[6], x[7], x[8]);
    if (b > a) out.push([a, b]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** Prefix sums of the reference's occupancy: covered(a, b) is O(1). */
class Occupancy {
  private readonly prefix: Int32Array;
  readonly total: number;
  constructor(spans: Span[], endMs: number) {
    const n = Math.ceil(endMs / BIN) + 2;
    const diff = new Int32Array(n + 1);
    for (const [a, b] of spans) {
      const i = Math.max(0, Math.floor(a / BIN));
      const j = Math.min(n, Math.ceil(b / BIN));
      if (j > i) {
        diff[i]++;
        diff[j]--;
      }
    }
    this.prefix = new Int32Array(n + 1);
    let run = 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      run += diff[i];
      acc += run > 0 ? 1 : 0;
      this.prefix[i + 1] = acc;
    }
    this.total = acc;
  }
  /** Covered bins between two times (ms). */
  covered(a: number, b: number): number {
    const n = this.prefix.length - 1;
    const i = Math.max(0, Math.min(n, Math.floor(a / BIN)));
    const j = Math.max(0, Math.min(n, Math.ceil(b / BIN)));
    return j > i ? this.prefix[j] - this.prefix[i] : 0;
  }
}

function fit(ref: Occupancy, spans: Span[], ratio: number, offset: number, from = 0, to = spans.length): number {
  let c = 0;
  for (let k = from; k < to; k++) c += ref.covered(spans[k][0] * ratio + offset, spans[k][1] * ratio + offset);
  return c;
}

function bestOffset(ref: Occupancy, spans: Span[], ratio: number, lo: number, hi: number, step: number, from?: number, to?: number): { offset: number; score: number } {
  let best = { offset: 0, score: -1 };
  for (let o = lo; o <= hi; o += step) {
    const s = fit(ref, spans, ratio, o, from, to);
    // Ties: the smaller move wins.
    if (s > best.score || (s === best.score && Math.abs(o) < Math.abs(best.offset))) best = { offset: o, score: s };
  }
  return best;
}

/** The time map that lines `subject` up with `reference`, with the fit before and after (0–1 of the reference). */
export function alignSpans(reference: Span[], subject: Span[]): AutoSyncResponse {
  const identity: SubtitleSyncMap = { ratio: 1, offsetMs: 0, groups: [] };
  if (!reference.length || !subject.length) return { map: identity, score: 0, scoreBefore: 0 };
  const end = Math.max(reference[reference.length - 1][1], subject[subject.length - 1][1] * 1.05) + MAX_OFFSET;
  const ref = new Occupancy(reference, end);
  const norm = (c: number) => (ref.total ? Math.round((c / ref.total) * 1000) / 1000 : 0);
  const before = fit(ref, subject, 1, 0);

  // 1. Rate + constant delay: the wide search runs on an even sample of cues (keeps a long film well under a second),
  // the winner is refined on all of them. Another rate must beat the plain shift clearly (2 %) to be chosen.
  const step = Math.max(1, Math.floor(subject.length / SAMPLE_CUES));
  const sample = subject.filter((_, k) => k % step === 0);
  let best = { ratio: 1, offset: 0, score: -1 };
  for (const ratio of RATIOS) {
    const coarse = bestOffset(ref, sample, ratio, -MAX_OFFSET, MAX_OFFSET, COARSE);
    if (best.score < 0 || coarse.score > best.score * 1.02) best = { ratio, offset: coarse.offset, score: coarse.score };
  }
  const fine = bestOffset(ref, subject, best.ratio, best.offset - COARSE, best.offset + COARSE, BIN);
  const ratio = best.ratio;
  const offsetMs = fine.offset;

  // 2. Per-group drift, groups split at long gaps (in the moved timeline).
  const moved = (t: number) => t * ratio + offsetMs;
  const bounds: number[] = [0];
  for (let k = 1; k < subject.length; k++) {
    if (moved(subject[k][0]) - moved(subject[k - 1][1]) >= GROUP_GAP && k - bounds[bounds.length - 1] >= GROUP_MIN_CUES) bounds.push(k);
  }
  if (subject.length - bounds[bounds.length - 1] < GROUP_MIN_CUES && bounds.length > 1) bounds.pop();
  const groups: SubtitleSyncMap['groups'] = [];
  let prevExtra = 0;
  for (let g = 0; g < bounds.length; g++) {
    const from = bounds[g];
    const to = g + 1 < bounds.length ? bounds[g + 1] : subject.length;
    const base = fit(ref, subject, ratio, offsetMs, from, to);
    const coarse = bestOffset(ref, subject, ratio, offsetMs - GROUP_RANGE, offsetMs + GROUP_RANGE, COARSE, from, to);
    const refined = bestOffset(ref, subject, ratio, coarse.offset - COARSE, coarse.offset + COARSE, BIN, from, to);
    // Only a clear win moves a group (5 % of its own fit), so noise never shifts a well-timed group.
    const extra = refined.score > base * 1.05 + 1 ? refined.offset - offsetMs : 0;
    if (extra !== prevExtra) {
      const startMoved = moved(subject[from][0]);
      const fromMs = from === 0 ? 0 : Math.round((moved(subject[from - 1][1]) + startMoved) / 2);
      groups.push({ fromMs, offsetMs: extra });
      prevExtra = extra;
    }
  }
  const map: SubtitleSyncMap = { ratio: Math.round(ratio * 1e6) / 1e6, offsetMs, groups };
  const after = subject.reduce((c, [a, b]) => c + ref.covered(applySyncMap(a, map), applySyncMap(b, map)), 0);
  return { map, score: norm(after), scoreBefore: norm(before) };
}

async function spansOf(mediaId: string, index: number): Promise<Span[]> {
  const ex = extractSubtitle(mediaId, index, 'vtt');
  try {
    await ex.done;
  } catch (e) {
    throw new HttpError(500, `Subtitle extraction failed: ${(e as Error).message}`, 'subtitle_failed');
  }
  return vttSpans(await fs.readFile(ex.file, 'utf8'));
}

/** POST /items/:id/subtitles/autosync */
export async function autoSync(itemId: string, req: AutoSyncRequest): Promise<AutoSyncResponse> {
  const media = db.get<{ id: string; subs: string }>('SELECT id, subs FROM media WHERE id = ? AND item_id = ?', String(req?.mediaId ?? ''), itemId);
  if (!media) throw notFound('Media not found');
  const subs = parseJson<{ index: number; codec: string }[]>(media.subs, []);
  const subject = subs.find((s) => s.index === Number(req.subtitleIndex));
  const reference = subs.find((s) => s.index === Number(req.referenceIndex));
  if (!subject || !reference) throw badRequest('Unknown subtitle track');
  if (subject.index === reference.index) throw badRequest('Choose a different track as the reference');
  for (const s of [subject, reference]) {
    const f = formatForCodec(s.codec);
    if (!f || isImageFormat(f)) throw badRequest('AutoSync needs text subtitles on both sides');
  }
  const [refSpans, subSpans] = await Promise.all([spansOf(media.id, reference.index), spansOf(media.id, subject.index)]);
  if (refSpans.length < 10 || subSpans.length < 10) throw badRequest('Not enough subtitle lines to compare');
  return alignSpans(refSpans, subSpans);
}
