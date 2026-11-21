import { spawn } from 'node:child_process';
import type { AcoustIdCandidate, IdentifyResponse, MusicSettingsResponse } from '@mediamax/shared';
import { db, type Row } from '../../db.js';
import { config } from '../../config.js';
import { nowIso, parseJson } from '../../util/misc.js';
import { logger } from '../../util/log.js';
import { badRequest, notFound } from '../../util/errors.js';
import { baseUrl, providerFetch, url } from '../metadata/http.js';
import { rebuildCredits } from './credits.js';
import { getMusicSettings, publicMusicSettings } from './settings.js';
import { isMbid } from './tags.js';

/**
 * AcoustID: identify tracks by sound. A Chromaprint fingerprint (fpcalc, or ffmpeg's chromaprint muxer) of the first
 * two minutes is looked up at api.acoustid.org (application key from the admin; 3 requests/second). Matches are
 * stored in the database only — media files are never written to.
 */

const log = logger('acoustid');

export interface Fingerprinter { available: boolean; tool: 'fpcalc' | 'ffmpeg' | null; detail: string; path: string | null }
let detected: Promise<Fingerprinter> | null = null;

function run(cmd: string, args: string[], timeoutMs = 60000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: '', err: (e as Error).message });
    }
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

/** fpcalc (MEDIAMAX_FPCALC or PATH), else ffmpeg built with --enable-chromaprint. */
export function detectFingerprinter(force = false): Promise<Fingerprinter> {
  if (detected && !force) return detected;
  detected = (async () => {
    const fp = process.env.MEDIAMAX_FPCALC || 'fpcalc';
    if (fp !== 'none') {
      const r = await run(fp, ['-version'], 10000);
      if (r.code === 0) return { available: true, tool: 'fpcalc', detail: (r.out || r.err).trim().split('\n')[0] || 'fpcalc', path: fp } as Fingerprinter;
    }
    const m = await run(config.ffmpeg, ['-hide_banner', '-muxers'], 10000);
    if (m.code === 0 && /\bchromaprint\b/.test(m.out)) return { available: true, tool: 'ffmpeg', detail: 'ffmpeg chromaprint muxer', path: config.ffmpeg } as Fingerprinter;
    return { available: false, tool: null, detail: 'Install Chromaprint (fpcalc: Debian/Ubuntu package libchromaprint-tools) or set KINORA_FPCALC', path: null } as Fingerprinter;
  })();
  return detected;
}

/** Chromaprint fingerprint (compressed, base64) of the first 120 seconds. */
export async function fingerprint(file: string, durationMs: number | null): Promise<{ fingerprint: string; duration: number }> {
  const f = await detectFingerprinter();
  if (!f.available || !f.path) throw badRequest(f.detail);
  if (f.tool === 'fpcalc') {
    const r = await run(f.path, ['-json', '-length', '120', file]);
    const j = parseJson<{ duration?: number; fingerprint?: string }>(r.out, {});
    if (r.code !== 0 || !j.fingerprint) throw new Error(`fpcalc failed: ${r.err.trim().slice(0, 200) || `exit ${r.code}`}`);
    return { fingerprint: j.fingerprint, duration: Math.round(j.duration ?? (durationMs ?? 0) / 1000) };
  }
  const r = await run(f.path, ['-v', 'error', '-i', file, '-t', '120', '-map', '0:a:0', '-f', 'chromaprint', '-fp_format', 'base64', '-']);
  const fpStr = r.out.trim();
  if (r.code !== 0 || !fpStr) throw new Error(`ffmpeg chromaprint failed: ${r.err.trim().slice(0, 200) || `exit ${r.code}`}`);
  return { fingerprint: fpStr, duration: Math.round((durationMs ?? 0) / 1000) };
}

/** AcoustID lookup results → candidates, best first (one per linked recording). */
export function mapAcoustIdResults(results: any[]): AcoustIdCandidate[] {
  const out: AcoustIdCandidate[] = [];
  for (const r of results ?? []) {
    const score = Number(r.score) || 0;
    const recs: any[] = r.recordings ?? [];
    if (!recs.length) {
      out.push({ score, acoustid: String(r.id), recordingMbid: null, title: null, artists: [], releaseGroup: null, durationSec: null });
      continue;
    }
    for (const rec of recs) {
      const rg = (rec.releasegroups ?? [])[0];
      out.push({
        score, acoustid: String(r.id), recordingMbid: isMbid(rec.id) ? rec.id : null, title: rec.title ?? null,
        artists: (rec.artists ?? []).map((a: any) => ({ name: String(a.name ?? ''), mbid: isMbid(a.id) ? a.id : null, joinPhrase: String(a.joinphrase ?? '') })),
        releaseGroup: rg ? { mbid: rg.id, title: rg.title, type: rg.type ? String(rg.type).toLowerCase() : null } : null,
        durationSec: rec.duration ? Math.round(rec.duration) : null,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || Number(!!b.title) - Number(!!a.title)).slice(0, 10);
}

export async function lookup(fp: string, duration: number): Promise<AcoustIdCandidate[]> {
  const key = getMusicSettings().acoustid.apiKey;
  if (!key) throw badRequest('Add an AcoustID application key in Server settings → Metadata');
  const r = await providerFetch('acoustid', url(baseUrl('acoustid'), '/v2/lookup', { client: key, meta: 'recordings releasegroups compress', duration, fingerprint: fp }), { ttlHours: 24 * 30 });
  const d = r.data as any;
  if (d?.status === 'error') throw new Error(`AcoustID: ${d.error?.message ?? 'lookup failed'}`);
  return mapAcoustIdResults(d?.results ?? []);
}

/** Why identifying can't run right now (null = it can). */
export async function unavailableReason(): Promise<string | null> {
  if (!getMusicSettings().acoustid.apiKey) return 'No AcoustID application key yet (Server settings → Metadata → Music identification).';
  const f = await detectFingerprinter();
  return f.available ? null : f.detail;
}

export async function identifyTrack(itemId: string): Promise<IdentifyResponse> {
  const t = db.get<{ id: string; type: string; duration_ms: number | null }>('SELECT id, type, duration_ms FROM items WHERE id = ?', itemId);
  if (!t) throw notFound('Item not found');
  if (t.type !== 'track') throw badRequest('Only tracks can be identified by sound');
  const reason = await unavailableReason();
  if (reason) return { available: false, reason, candidates: [] };
  const m = db.get<{ path: string | null }>('SELECT path FROM media WHERE item_id = ? AND path IS NOT NULL LIMIT 1', itemId);
  if (!m?.path) throw badRequest('This track has no local file');
  try {
    const fp = await fingerprint(m.path, t.duration_ms);
    const candidates = await lookup(fp.fingerprint, fp.duration);
    db.upsert('acoustid_results', { item_id: itemId, candidates: JSON.stringify(candidates), status: candidates.length ? 'pending' : 'nomatch', error: null, checked_at: nowIso(), applied_at: null }, 'item_id');
    return { available: true, reason: null, candidates };
  } catch (e) {
    db.upsert('acoustid_results', { item_id: itemId, candidates: '[]', status: 'error', error: (e as Error).message.slice(0, 300), checked_at: nowIso(), applied_at: null }, 'item_id');
    throw e;
  }
}

/** Apply a chosen match: title, credits, recording MBID and AcoustID id — in the database only. */
export function applyIdentification(itemId: string, c: Pick<AcoustIdCandidate, 'recordingMbid' | 'acoustid' | 'title' | 'artists' | 'score'>) {
  const row = db.get<Row>('SELECT * FROM items WHERE id = ?', itemId);
  if (!row || row.type !== 'track') throw notFound('Track not found');
  if (c.recordingMbid && !isMbid(c.recordingMbid)) throw badRequest('Invalid recording id');
  const locked = new Set(parseJson<string[]>(row.locked_fields, []));
  const ids = parseJson<Record<string, string>>(row.external_ids, {});
  if (c.recordingMbid) ids.musicbrainzRecording = c.recordingMbid;
  if (c.acoustid && isMbid(c.acoustid)) ids.acoustid = c.acoustid;
  const artists = (c.artists ?? []).filter((a) => a?.name).slice(0, 20).map((a) => ({ name: String(a.name).slice(0, 300), mbid: isMbid(a.mbid) ? a.mbid : null, joinPhrase: String(a.joinPhrase ?? '').slice(0, 40) }));
  const artistString = artists.map((a, i) => a.name + (i < artists.length - 1 ? a.joinPhrase || ', ' : '')).join('');
  const pm = parseJson<Record<string, unknown>>(row.provider_meta, {});
  const patch: Row = {
    external_ids: JSON.stringify(ids), updated_at: nowIso(), metadata_fetched_at: row.metadata_fetched_at ?? nowIso(),
    provider_meta: JSON.stringify({ ...pm, identified: { title: c.title, artist: artistString || null, score: c.score, at: nowIso() }, ...(artists.length ? { credits: artists } : {}) }),
  };
  if (c.title && !locked.has('title')) patch.title = String(c.title).slice(0, 500);
  db.update('items', itemId, patch);
  db.run("UPDATE acoustid_results SET status = 'applied', applied_at = ? WHERE item_id = ?", nowIso(), itemId);
  rebuildCredits(row.library_id, [itemId]);
}

/** Tracks with no recording MBID and no usable artist/title tags, not yet identified. */
export const UNTAGGED_WHERE = `i.type = 'track' AND json_extract(i.external_ids, '$.musicbrainzRecording') IS NULL
  AND (COALESCE(json_extract(i.extra, '$.tags.artist'), '') = '' OR COALESCE(json_extract(i.extra, '$.tags.title'), '') = '')
  AND json_extract(i.provider_meta, '$.identified') IS NULL`;

export const countUntagged = () => db.get<{ n: number }>(`SELECT COUNT(*) n FROM items i WHERE ${UNTAGGED_WHERE}`)!.n;

/**
 * Identify untagged tracks (admin task, and after scans when enabled). Matches at or above the admin's
 * auto-apply score are applied; others wait for confirmation in the track's Fix match dialog.
 */
export async function identifyUntagged(progress: (p: number) => void = () => undefined, limit = 500): Promise<{ checked: number; applied: number }> {
  if (await unavailableReason()) return { checked: 0, applied: 0 };
  const rows = db.all<{ id: string }>(`SELECT i.id FROM items i LEFT JOIN acoustid_results r ON r.item_id = i.id WHERE ${UNTAGGED_WHERE}
    AND (r.item_id IS NULL OR (r.status IN ('nomatch','error') AND r.checked_at < ?)) ORDER BY i.added_at DESC LIMIT ?`, new Date(Date.now() - 30 * 86400_000).toISOString(), limit);
  const auto = getMusicSettings().acoustid.autoApplyScore;
  let applied = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      const r = await identifyTrack(rows[i].id);
      const best = r.candidates[0];
      if (auto > 0 && best && best.score >= auto && best.recordingMbid && best.title) {
        applyIdentification(rows[i].id, best);
        applied++;
      }
    } catch (e) {
      log.debug(`identify ${rows[i].id}: ${(e as Error).message}`);
    }
    progress(((i + 1) / rows.length) * 100);
  }
  return { checked: rows.length, applied };
}

/** After a music scan: only when the admin turned automatic identification on. */
export async function autoIdentifyAfterScan() {
  if (!getMusicSettings().acoustid.autoIdentify) return;
  const r = await identifyUntagged(undefined, 200);
  if (r.checked) log.info(`AcoustID: checked ${r.checked} untagged track(s), applied ${r.applied}`);
}

export async function musicSettingsState(): Promise<MusicSettingsResponse> {
  const f = await detectFingerprinter();
  return { settings: publicMusicSettings(), fingerprinter: { available: f.available, tool: f.tool, detail: f.detail }, untagged: countUntagged() };
}
