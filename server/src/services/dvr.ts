import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { CreateRecordingRequest, CreateRecordingRuleRequest, HomeRow, Recording, RecordingRule, User } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { config } from '../config.js';
import { newId } from '../util/ids.js';
import { badRequest, forbidden, notFound } from '../util/errors.js';
import { nowIso, parseJson, REMOTE_PROTOCOLS } from '../util/misc.js';
import { logger } from '../util/log.js';
import { runComskip, edlPathFor } from './edl.js';
import { getSettings } from './settings.js';
import { events, bus } from './events.js';
import { logActivity } from './activity.js';
import { accessibleChannelRow, channelInputArgs, channelStreamUrl, trackUpstream } from './livetv/livetv.js';
import { effEpg } from './livetv/epg/epg.js';
import { scanLibrary } from './scanner.js';
import { ffprobeJson } from './probe.js';
import { homeHooks, getItem, itemsByIds } from './items.js';
import { getBranding } from './branding.js';

const log = logger('dvr');

function toRecording(r: Row): Recording {
  return {
    id: r.id, channelId: r.channel_id, channelName: r.channel_name, programId: r.program_id ?? null, title: r.title, description: r.description ?? null,
    start: r.start, end: r.end, status: r.status, itemId: r.item_id ?? null, ruleId: r.rule_id ?? null, error: r.error ?? null, sizeBytes: r.size_bytes ?? null, createdBy: r.created_by,
    priority: r.priority ?? 100, conflict: !!r.conflict,
    gapSeconds: r.gap_seconds ?? null,
    leftoverParts: parseJson<string[]>(r.leftover_parts, []).flatMap((p) => {
      try {
        return [{ name: path.basename(p), sizeBytes: fs.statSync(p).size }];
      } catch {
        return []; // removed by hand
      }
    }),
  };
}
const toRule = (r: Row): RecordingRule => ({
  id: r.id, titleMatch: r.title_match, channelId: r.channel_id ?? null, newOnly: !!r.new_only, keepLatest: r.keep_latest ?? null,
  paddingBeforeMin: r.padding_before, paddingAfterMin: r.padding_after, enabled: !!r.enabled,
  priority: r.priority ?? 50, daysOfWeek: parseJson<number[] | null>(r.days, null), timeFrom: r.time_from ?? null, timeTo: r.time_to ?? null, skipRepeats: r.skip_repeats !== 0,
});

/**
 * Mark scheduled recordings that would exceed their source's tuner/connection limit.
 * Greedy by priority (then creation time); in-progress recordings always keep their slot.
 */
export function recomputeConflicts() {
  const now = nowIso();
  const rows = db.all(`SELECT r.*, c.source_id, s.max_connections FROM recordings r JOIN channels c ON c.id = r.channel_id JOIN live_sources s ON s.id = c.source_id
    WHERE r.status IN ('scheduled','recording') AND r.end > ? ORDER BY CASE r.status WHEN 'recording' THEN 0 ELSE 1 END, r.priority DESC, r.created_at`, now);
  const accepted = new Map<string, { start: string; end: string }[]>();
  const changed: string[] = [];
  for (const r of rows) {
    let conflict = 0;
    if (r.max_connections) {
      const list = accepted.get(r.source_id) ?? [];
      // Peak overlap within this recording's window.
      const overlapping = list.filter((a) => a.start < r.end && a.end > r.start);
      const points = [r.start, ...overlapping.map((a) => a.start)].filter((t) => t >= r.start && t < r.end);
      const peak = Math.max(0, ...points.map((t) => overlapping.filter((a) => a.start <= t && a.end > t).length));
      if (r.status !== 'recording' && peak >= r.max_connections) conflict = 1;
      else accepted.set(r.source_id, [...list, { start: r.start, end: r.end }]);
    }
    if ((r.conflict ? 1 : 0) !== conflict) {
      db.run('UPDATE recordings SET conflict = ? WHERE id = ?', conflict, r.id);
      changed.push(r.id);
    }
  }
  for (const id of changed) emit(id);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function inWindow(startIso: string, from: string | null, to: string | null): boolean {
  if (!from || !to) return true;
  const d = new Date(startIso);
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return from <= to ? t >= from && t <= to : t >= from || t <= to; // window may wrap past midnight
}

function assertDvr(user: User) {
  if (!getBranding().features.dvr) throw forbidden('DVR is disabled');
  if (!user.allowDvr && !user.isAdmin) throw forbidden('Recording is not enabled for your account');
}

export function listRecordings(user: User, status?: string): Recording[] {
  assertDvr(user);
  const rows = status ? db.all('SELECT * FROM recordings WHERE status = ? ORDER BY start DESC', status) : db.all('SELECT * FROM recordings ORDER BY start DESC LIMIT 500');
  return rows.map(toRecording);
}

function emit(id: string) {
  const r = db.get('SELECT * FROM recordings WHERE id = ?', id);
  if (r) events.broadcast({ type: 'recording.updated', recording: toRecording(r) });
}

export function scheduleRecording(user: User, req: CreateRecordingRequest, ruleId: string | null = null, priority = 90): Recording {
  if (ruleId === null) assertDvr(user);
  const ch = ruleId === null ? accessibleChannelRow(user, req.channelId) : db.get('SELECT * FROM channels WHERE id = ?', req.channelId);
  if (!ch) throw notFound('Channel not found');
  const custom = parseJson<Record<string, any>>(ch.custom, {});
  const s = getSettings().dvr;
  let title = req.title ?? '';
  let description: string | null = null;
  let start = req.start ? new Date(req.start) : new Date();
  let end = req.end ? new Date(req.end) : new Date(Date.now() + 3600000);
  if (req.programId) {
    const p = db.get('SELECT * FROM programs WHERE id = ?', req.programId);
    if (!p) throw notFound('Programme not found');
    const dup = db.get("SELECT id FROM recordings WHERE program_id = ? AND status IN ('scheduled','recording')", req.programId);
    if (dup) return toRecording(db.get('SELECT * FROM recordings WHERE id = ?', dup.id)!);
    title = title || p.title + (p.subtitle ? ` - ${p.subtitle}` : '');
    description = p.description;
    start = new Date(p.start);
    end = new Date(p.end);
  }
  const pad = (v: number | undefined, d: number) => Math.max(0, Math.min(120, Number.isFinite(Number(v)) ? Number(v) : d));
  start = new Date(start.getTime() - pad(req.paddingBeforeMin, s.paddingBeforeMin) * 60000);
  end = new Date(end.getTime() + pad(req.paddingAfterMin, s.paddingAfterMin) * 60000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw badRequest('Invalid start or end time');
  if (end.getTime() <= Date.now()) throw badRequest('That programme has already finished');
  if (end <= start) throw badRequest('End must be after start');
  if (end.getTime() - start.getTime() > 12 * 3600000) throw badRequest('Recordings are limited to 12 hours');
  const id = newId();
  db.insert('recordings', {
    id, channel_id: ch.id, channel_name: custom.name ?? ch.name, program_id: req.programId ?? null, title: title || `${custom.name ?? ch.name} recording`,
    description, start: start.toISOString(), end: end.toISOString(), status: 'scheduled', rule_id: ruleId, created_by: user.id, created_at: nowIso(),
    priority: Math.max(0, Math.min(100, Math.round(priority))),
  });
  recomputeConflicts();
  logActivity('dvr.schedule', `Recording scheduled: ${title} on ${ch.name}`, { userId: user.id, userName: user.displayName });
  emit(id);
  void tick();
  return toRecording(db.get('SELECT * FROM recordings WHERE id = ?', id)!);
}

const active = new Map<string, ChildProcess>();

/** Change a scheduled recording's priority (0–100); tuner conflicts are re-checked straight away. */
export function updateRecording(user: User, id: string, req: { priority?: number }): Recording {
  assertDvr(user);
  const r = db.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!r) throw notFound('Recording not found');
  if (r.created_by !== user.id && !user.isAdmin) throw forbidden();
  if (req.priority !== undefined) {
    if (!Number.isFinite(Number(req.priority))) throw badRequest('Priority must be a number');
    db.run('UPDATE recordings SET priority = ? WHERE id = ?', Math.max(0, Math.min(100, Math.round(Number(req.priority)))), id);
    recomputeConflicts();
    emit(id);
  }
  return toRecording(db.get('SELECT * FROM recordings WHERE id = ?', id)!);
}

export function cancelRecording(user: User, id: string) {
  assertDvr(user);
  const r = db.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!r) throw notFound('Recording not found');
  if (r.created_by !== user.id && !user.isAdmin) throw forbidden();
  if (finishing.has(id)) throw badRequest('This recording is being saved; try again in a moment');
  const p = active.get(id);
  if (p) {
    p.kill('SIGINT');
    db.run("UPDATE recordings SET status = 'cancelled' WHERE id = ?", id);
  } else if (r.status === 'scheduled') {
    db.run("UPDATE recordings SET status = 'cancelled' WHERE id = ?", id);
  } else {
    // Completed/failed: delete its file(s) + item.
    deleteRecordingFiles(r);
    db.run('DELETE FROM recordings WHERE id = ?', id);
    return;
  }
  recomputeConflicts();
  emit(id);
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Recording';

function ensureRecordingsLibrary(dir: string): string {
  const libs = db.all("SELECT * FROM libraries WHERE type = 'videos'");
  const hit = libs.find((l) => parseJson<string[]>(l.paths, []).includes(dir));
  if (hit) return hit.id;
  const id = newId();
  db.insert('libraries', { id, name: 'Recordings', type: 'videos', paths: JSON.stringify([dir]), fetch_metadata: 0, sort_order: 99, created_at: nowIso() });
  return id;
}

/** One file of a recording. A recording resumed after a server restart has several, joined into one when it ends. */
interface Part {
  path: string;
  startedAt: string;
  /** Last write (file mtime), filled in when the part was interrupted or the recording ended. */
  endedAt?: string | null;
}

/** Recordings whose ffmpeg has ended and that are being saved (parts joined, comskip, library import). */
const finishing = new Set<string>();
/** ffmpeg processes joining parts; killed on shutdown like the recordings themselves. */
const joining = new Set<ChildProcess>();
let shuttingDown = false;
let legacyChecked = false;
/** Smaller files are failed starts (no stream), not recordings. */
const MIN_PART_BYTES = 100_000;

const stampOf = (start: string) => new Date(start).toISOString().slice(0, 16).replace('T', ' ').replace(':', '');

function basePathFor(r: Row): string {
  const dir = path.join(getSettings().dvr.recordingsPath, safe(r.title.split(' - ')[0]));
  return path.join(dir, `${safe(r.title)} (${stampOf(r.start)}).ts`);
}

function partsOf(r: Row): Part[] {
  const parts = parseJson<Part[]>(r.parts, []).filter((p) => p && typeof p.path === 'string');
  // Rows from before parts were tracked: the file being recorded is the only part.
  if (!parts.length && r.path) parts.push({ path: r.path, startedAt: r.start });
  return parts;
}

const sizeOf = (p: string) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
};
const mtimeIso = (p: string) => {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return null;
  }
};

/** Time lost between consecutive parts, in seconds (null for a single part). */
function gapBetween(parts: Part[]): number | null {
  if (parts.length < 2) return null;
  let gap = 0;
  for (let i = 1; i < parts.length; i++) {
    const prevEnd = Date.parse(parts[i - 1].endedAt ?? '');
    const nextStart = Date.parse(parts[i].startedAt);
    if (Number.isFinite(prevEnd) && Number.isFinite(nextStart) && nextStart > prevEnd) gap += (nextStart - prevEnd) / 1000;
  }
  return Math.round(gap);
}

function startRecording(r: Row) {
  const ch = db.get('SELECT * FROM channels WHERE id = ?', r.channel_id);
  if (!ch) {
    db.run("UPDATE recordings SET status = 'failed', error = 'Channel no longer exists' WHERE id = ?", r.id);
    emit(r.id);
    return;
  }
  const base = basePathFor(r);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  // Resumed after a restart: what was recorded so far stays as the earlier part(s); they're joined when it ends.
  const parts = r.status === 'recording' ? partsOf(r).filter((p) => fs.existsSync(p.path)) : [];
  for (const p of parts) p.endedAt ??= mtimeIso(p.path);
  let file = base;
  if (parts.length) {
    let n = parts.length + 1;
    const partName = (i: number) => base.replace(/\.ts$/, ` - part ${i}.ts`);
    while (fs.existsSync(partName(n)) || parts.some((p) => p.path === partName(n))) n++;
    file = partName(n);
  }
  parts.push({ path: file, startedAt: nowIso() });
  const durationSec = Math.max(10, Math.round((Date.parse(r.end) - Date.now()) / 1000));
  const url = channelStreamUrl(ch);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...channelInputArgs(ch, url), '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
    ...REMOTE_PROTOCOLS, '-i', url, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-t', String(durationSec), '-f', 'mpegts', file];
  log.info(`${parts.length > 1 ? `Resuming recording "${r.title}" (part ${parts.length})` : `Recording "${r.title}"`} for ${durationSec}s → ${file}`);
  const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
  active.set(r.id, p);
  trackUpstream(ch.source_id, 1);
  db.run("UPDATE recordings SET status = 'recording', path = ?, parts = ? WHERE id = ?", file, JSON.stringify(parts), r.id);
  emit(r.id);
  p.on('exit', (code) => {
    active.delete(r.id);
    trackUpstream(ch.source_id, -1);
    void finishRecording(r.id, code, err).catch((e) => log.error(`Saving recording "${r.title}" failed`, e));
  });
}

/**
 * A recording's ffmpeg ended (or it ended while the server was down): join its parts into one file, import it, and
 * record any gap. Exported for tests.
 */
export async function finishRecording(id: string, code: number | null, err: string) {
  if (finishing.has(id)) return;
  finishing.add(id);
  try {
    await saveRecording(id, code, err);
  } finally {
    finishing.delete(id);
  }
}

async function saveRecording(id: string, code: number | null, err: string) {
  const r = db.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!r) return;
  const parts = partsOf(r);
  for (const p of parts) p.endedAt ??= mtimeIso(p.path);
  const kept = parts.filter((p) => sizeOf(p.path) > MIN_PART_BYTES);
  for (const p of parts) if (!kept.includes(p)) fs.rmSync(p.path, { force: true });
  if (!kept.length) {
    db.run("UPDATE recordings SET status = 'failed', error = ?, parts = NULL WHERE id = ?", err.trim().slice(-300) || (code === null ? 'Nothing was recorded' : `ffmpeg exited with ${code}`), id);
    logActivity('dvr.failed', `Recording failed: ${r.title}`, { severity: 'error' });
    bus.emit('recording.failed', toRecording(db.get('SELECT * FROM recordings WHERE id = ?', id)!));
    emit(id);
    return;
  }
  let file = kept[0].path;
  const leftovers = parseJson<string[]>(r.leftover_parts, []);
  const gap = gapBetween(parts);
  if (kept.length > 1) {
    const infos = await probeParts(kept.map((p) => p.path));
    const joined = await joinParts(kept.map((p) => p.path), infos);
    // Stopped by a shutdown: every part is still on disk and listed, so the next start saves it.
    if (shuttingDown) return;
    if (joined.ok) {
      for (const p of kept.slice(1)) fs.rmSync(p.path, { force: true });
      log.info(`Joined ${kept.length} parts of "${r.title}" (interrupted for ${gap ?? 0}s)`);
    } else {
      // Never lose recorded content: the longest readable part (else the biggest) becomes the recording, the others
      // stay on disk, listed with it (and deleted together with it).
      const len = (i: number) => Number(infos[i]?.format?.duration) || 0;
      let best = 0;
      for (let i = 1; i < kept.length; i++) if (len(i) > len(best) || (len(i) === len(best) && sizeOf(kept[i].path) > sizeOf(kept[best].path))) best = i;
      const main = kept[best];
      file = main.path;
      for (const p of kept) if (p !== main && !leftovers.includes(p.path)) leftovers.push(p.path);
      log.warn(`Could not join the ${kept.length} parts of "${r.title}" (${joined.error}); keeping the extra part(s) next to it: ${leftovers.join(', ')}`);
      logActivity('dvr.join', `Recording ${r.title} was interrupted and its parts could not be joined; the extra part(s) were kept`, { severity: 'warning' });
    }
  }
  const status = r.status === 'cancelled' ? 'cancelled' : 'completed';
  db.run('UPDATE recordings SET status = ?, path = ?, size_bytes = ?, error = ?, parts = NULL, gap_seconds = ?, leftover_parts = ? WHERE id = ?',
    status, file, sizeOf(file), code === 0 || code === null ? null : err.trim().slice(-300) || null, gap, leftovers.length ? JSON.stringify(leftovers) : null, id);
  const libId = ensureRecordingsLibrary(getSettings().dvr.recordingsPath);
  if (await runComskip(file)) log.info(`Commercial markers found for "${r.title}"`);
  await scanLibrary(libId);
  const item = db.get('SELECT i.id FROM items i JOIN media m ON m.item_id = i.id WHERE m.path = ?', file);
  if (item) db.run('UPDATE items SET overview = COALESCE(overview, ?), title = ? WHERE id = ?', r.description, r.title, item.id), db.run('UPDATE recordings SET item_id = ? WHERE id = ?', item.id, id);
  logActivity('dvr.complete', `Recording finished: ${r.title}${gap ? ` (interrupted for about ${Math.max(1, Math.round(gap / 60))} min)` : ''}`);
  bus.emit('recording.completed', toRecording(db.get('SELECT * FROM recordings WHERE id = ?', id)!));
  enforceKeepLatest(r.rule_id);
  emit(id);
}

const MUXERS: Record<string, string> = { '.ts': 'mpegts', '.m2ts': 'mpegts', '.mkv': 'matroska', '.mp4': 'mp4', '.m4v': 'mp4', '.mov': 'mov' };

function runJoinFfmpeg(args: string[]): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    joining.add(p);
    let err = '';
    p.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', (e) => (joining.delete(p), resolve({ ok: false, err: e.message })));
    p.on('exit', (code) => (joining.delete(p), resolve({ ok: code === 0, err: err.trim() || `ffmpeg exited with ${code}` })));
  });
}

/**
 * Concatenate parts (same container and streams, as written by startRecording) into the first part's path with the
 * concat demuxer and stream copy. The result is checked (readable, about as long as the parts together) before it
 * replaces the first part; the caller deletes the other parts only on success.
 */
async function probeParts(paths: string[]): Promise<(any | null)[]> {
  const out: (any | null)[] = [];
  for (const p of paths) out.push(await ffprobeJson(p, [], 120000).catch(() => null));
  return out;
}

async function joinParts(paths: string[], infos: (any | null)[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const unreadable = infos.findIndex((i) => !i);
  if (unreadable >= 0) return { ok: false, error: `${path.basename(paths[unreadable])} cannot be read` };
  // The concat demuxer needs identical streams in every part.
  const sig = (i: any) => (i.streams ?? []).filter((s: any) => s.codec_type === 'video' || s.codec_type === 'audio').map((s: any) => `${s.codec_type}:${s.codec_name}`).join(',');
  const durations = infos.map((i) => Number(i.format?.duration));
  const bad = durations.findIndex((d) => !(d > 0));
  if (bad >= 0) return { ok: false, error: `${path.basename(paths[bad])} has no readable duration` };
  const odd = infos.findIndex((i) => !sig(i) || sig(i) !== sig(infos[0]));
  if (odd >= 0) return { ok: false, error: `${path.basename(paths[odd])} has different audio/video streams` };
  const target = paths[0];
  const ext = path.extname(target).toLowerCase();
  // Dot-files: the library scanner ignores them, so a half-written join never shows up as a video.
  const tmp = path.join(path.dirname(target), `.${path.basename(target, ext)}.joining${ext}`);
  const list = path.join(path.dirname(target), `.${path.basename(target, ext)}.parts.txt`);
  try {
    fs.writeFileSync(list, paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const res = await runJoinFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy',
      ...(MUXERS[ext] ? ['-f', MUXERS[ext]] : []), tmp]);
    if (!res.ok) return { ok: false, error: res.err.slice(-300) };
    const want = durations.reduce((a, b) => a + b, 0);
    let got = 0;
    try {
      got = Number((await ffprobeJson(tmp, [], 120000)).format?.duration);
    } catch {
      /* checked below */
    }
    if (!(got >= want * 0.9 - 2)) return { ok: false, error: `the joined file is ${Math.round(got || 0)}s long, expected about ${Math.round(want)}s` };
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    fs.rmSync(list, { force: true });
    fs.rmSync(tmp, { force: true });
  }
}

/** Every file a recording owns: the recording, unjoined parts and leftover parts (and library items made from them). */
function deleteRecordingFiles(r: Row) {
  const files = new Set<string>([...(r.path ? [r.path] : []), ...parseJson<Part[]>(r.parts, []).map((p) => p.path), ...parseJson<string[]>(r.leftover_parts, [])]);
  for (const f of files) {
    if (typeof f !== 'string' || !f) continue;
    fs.rmSync(f, { force: true });
    fs.rmSync(edlPathFor(f), { force: true });
    // A leftover part may have been imported into the library as a video of its own.
    db.run('DELETE FROM items WHERE id IN (SELECT item_id FROM media WHERE path = ?)', f);
  }
  if (r.item_id) db.run('DELETE FROM items WHERE id = ?', r.item_id);
}

/**
 * Before parts were tracked, a recording resumed after a restart was written to a new file named "<title> (resumed)
 * (<start>).ts" and the file recorded before the restart was forgotten. Those files can be attributed exactly (same
 * folder rule, same start stamp, next to the recording), so they are listed as the recording's leftover parts — kept,
 * shown with it and deleted with it. Nothing else is touched. Exported for tests.
 */
export function attachLegacyOrphanParts() {
  const rows = db.all("SELECT * FROM recordings WHERE path LIKE '%(resumed)%' AND status != 'recording'");
  for (const r of rows) {
    const resumed = (path.basename(r.path).match(/ \(resumed\)/g) ?? []).length;
    const root = path.dirname(path.dirname(r.path));
    const leftovers = parseJson<string[]>(r.leftover_parts, []);
    const found: string[] = [];
    for (let k = 0; k < resumed; k++) {
      const t = r.title + ' (resumed)'.repeat(k);
      const f = path.join(root, safe(t.split(' - ')[0]), `${safe(t)} (${stampOf(r.start)}).ts`);
      if (f !== r.path && !leftovers.includes(f) && fs.existsSync(f)) found.push(f);
    }
    if (!found.length) continue;
    db.run('UPDATE recordings SET leftover_parts = ? WHERE id = ?', JSON.stringify([...leftovers, ...found]), r.id);
    log.info(`Recording "${r.title}": found ${found.length} part(s) recorded before a restart; listed with the recording: ${found.join(', ')}`);
  }
}

function enforceKeepLatest(ruleId: string | null) {
  if (!ruleId) return;
  const rule = db.get('SELECT * FROM recording_rules WHERE id = ?', ruleId);
  if (!rule?.keep_latest) return;
  const done = db.all("SELECT * FROM recordings WHERE rule_id = ? AND status = 'completed' ORDER BY start DESC", ruleId);
  for (const old of done.slice(rule.keep_latest)) {
    deleteRecordingFiles(old);
    db.run('DELETE FROM recordings WHERE id = ?', old.id);
  }
}

/**
 * Server shutdown: end running recordings (ffmpeg would otherwise keep recording as an orphan, holding a provider
 * connection, while the next start "resumes" the same recording). Their rows stay 'recording', so the next tick resumes
 * them when the programme is still on and marks them completed otherwise.
 */
export function stopActiveRecordings() {
  shuttingDown = true;
  // A join in progress is stopped too; its parts are all still on disk, so the next start saves the recording.
  for (const p of joining) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const p of active.values()) {
    try {
      p.removeAllListeners('exit');
      p.kill('SIGINT');
    } catch {
      /* already gone */
    }
  }
  active.clear();
}

/** Called every 15s by the scheduler. */
export async function tick() {
  const now = new Date().toISOString();
  const due = db.all("SELECT * FROM recordings WHERE status = 'scheduled' AND start <= ? AND end > ?", now, now);
  if (due.some((r) => r.conflict)) recomputeConflicts();
  for (const r of due) {
    if (active.has(r.id)) continue;
    const fresh = db.get('SELECT conflict FROM recordings WHERE id = ?', r.id);
    if (fresh?.conflict) {
      db.run("UPDATE recordings SET status = 'failed', error = 'Not recorded: all tuners/provider connections were busy with higher-priority recordings' WHERE id = ?", r.id);
      emit(r.id);
      continue;
    }
    startRecording(r);
  }
  db.run("UPDATE recordings SET status = 'failed', error = 'Missed (server was offline)' WHERE status = 'scheduled' AND end <= ?", now);
  // Recordings marked 'recording' but no process (server restart): resume them as a new part while the programme is
  // still on, otherwise save what was recorded (joining the parts).
  for (const r of db.all("SELECT * FROM recordings WHERE status = 'recording'")) {
    if (active.has(r.id) || finishing.has(r.id) || shuttingDown) continue;
    if (r.end > now) startRecording(r);
    else void finishRecording(r.id, null, '').catch((e) => log.error(`Saving recording "${r.title}" failed`, e));
  }
  if (!legacyChecked) {
    legacyChecked = true;
    try {
      attachLegacyOrphanParts();
    } catch (e) {
      log.warn(`Checking for parts of earlier resumed recordings failed: ${(e as Error).message}`);
    }
  }
}

/* -------------------------------- rules ----------------------------- */

function ruleExtras(req: Partial<CreateRecordingRuleRequest>): Row {
  const out: Row = {};
  if (req.priority !== undefined) out.priority = Math.max(0, Math.min(99, Math.round(Number(req.priority) || 0)));
  if (req.daysOfWeek !== undefined) {
    const days = req.daysOfWeek === null ? null : [...new Set(req.daysOfWeek.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    out.days = days && days.length && days.length < 7 ? JSON.stringify(days) : null;
  }
  for (const [k, col] of [['timeFrom', 'time_from'], ['timeTo', 'time_to']] as const) {
    if (req[k] === undefined) continue;
    const v = req[k];
    if (v !== null && !HHMM.test(String(v))) throw badRequest('Times must be HH:MM (24-hour)');
    out[col] = v;
  }
  if (req.skipRepeats !== undefined) out.skip_repeats = !!req.skipRepeats;
  return out;
}

const clampPad = (v: unknown, d: number) => Math.max(0, Math.min(120, Number.isFinite(Number(v)) ? Number(v) : d));

export function listRules(user: User): RecordingRule[] {
  assertDvr(user);
  return db.all('SELECT * FROM recording_rules ORDER BY title_match').map(toRule);
}

export function createRule(user: User, req: CreateRecordingRuleRequest): RecordingRule {
  assertDvr(user);
  if (!req.titleMatch?.trim() || req.titleMatch.trim().length < 2) throw badRequest('Title match is required (at least 2 characters)');
  if (req.channelId) accessibleChannelRow(user, req.channelId);
  const id = newId();
  const s = getSettings().dvr;
  db.insert('recording_rules', {
    id, title_match: req.titleMatch.trim().slice(0, 200), channel_id: req.channelId ?? null, new_only: !!req.newOnly, keep_latest: req.keepLatest ? Math.max(1, Math.min(1000, req.keepLatest)) : null,
    padding_before: clampPad(req.paddingBeforeMin, s.paddingBeforeMin), padding_after: clampPad(req.paddingAfterMin, s.paddingAfterMin), enabled: req.enabled ?? true, created_by: user.id,
    ...ruleExtras(req),
  });
  applyRules();
  return toRule(db.get('SELECT * FROM recording_rules WHERE id = ?', id)!);
}

export function updateRule(user: User, id: string, req: Partial<CreateRecordingRuleRequest>): RecordingRule {
  assertDvr(user);
  const r = db.get('SELECT * FROM recording_rules WHERE id = ?', id);
  if (!r) throw notFound('Rule not found');
  if (r.created_by !== user.id && !user.isAdmin) throw forbidden('You can only change your own recording rules');
  const p: Row = {};
  if (req.titleMatch !== undefined) p.title_match = req.titleMatch;
  if (req.channelId !== undefined) p.channel_id = req.channelId;
  if (req.newOnly !== undefined) p.new_only = req.newOnly;
  if (req.keepLatest !== undefined) p.keep_latest = req.keepLatest ? Math.max(1, Math.min(1000, req.keepLatest)) : null;
  if (req.paddingBeforeMin !== undefined) p.padding_before = clampPad(req.paddingBeforeMin, 1);
  if (req.paddingAfterMin !== undefined) p.padding_after = clampPad(req.paddingAfterMin, 5);
  if (req.enabled !== undefined) p.enabled = req.enabled;
  Object.assign(p, ruleExtras(req));
  db.update('recording_rules', id, p);
  applyRules();
  return toRule(db.get('SELECT * FROM recording_rules WHERE id = ?', id)!);
}

export function deleteRule(user: User, id: string) {
  assertDvr(user);
  const r = db.get('SELECT created_by FROM recording_rules WHERE id = ?', id);
  if (!r) throw notFound('Rule not found');
  if (r.created_by !== user.id && !user.isAdmin) throw forbidden('You can only delete your own recording rules');
  db.run('DELETE FROM recording_rules WHERE id = ?', id);
  db.run("UPDATE recordings SET status = 'cancelled' WHERE rule_id = ? AND status = 'scheduled'", id);
  recomputeConflicts();
}

/** Schedule upcoming programmes that match series rules. */
export function applyRules() {
  const rules = db.all('SELECT * FROM recording_rules WHERE enabled = 1');
  const now = nowIso();
  const horizon = new Date(Date.now() + 7 * 86400000).toISOString();
  for (const rule of rules) {
    const chans = rule.channel_id ? db.all('SELECT * FROM channels WHERE id = ?', rule.channel_id) : db.all('SELECT * FROM channels WHERE hidden = 0');
    const epgToChannel = new Map<string, Row>();
    for (const c of chans) {
      const e = effEpg(c);
      if (e && !epgToChannel.has(e)) epgToChannel.set(e, c);
    }
    if (!epgToChannel.size) continue;
    const progs = db.all(`SELECT * FROM programs WHERE title LIKE ? AND start > ? AND start < ? ${rule.new_only ? 'AND is_new = 1' : ''} ORDER BY start LIMIT 200`, `%${rule.title_match}%`, now, horizon);
    const seenSlots = new Set<string>();
    for (const p of progs) {
      const ch = epgToChannel.get(p.epg_channel_id);
      if (!ch) continue;
      // Avoid duplicate recordings of the same airing on multiple channels/sources.
      const slot = `${p.title}|${p.start}`;
      if (seenSlots.has(slot)) continue;
      seenSlots.add(slot);
      if (db.get("SELECT 1 FROM recordings WHERE (program_id = ? OR (title LIKE ? AND start = ?)) AND status != 'cancelled'", p.id, p.title + '%', new Date(Date.parse(p.start) - rule.padding_before * 60000).toISOString())) continue;
      const days = parseJson<number[] | null>(rule.days, null);
      if (days && !days.includes(new Date(p.start).getDay())) continue;
      if (!inWindow(p.start, rule.time_from, rule.time_to)) continue;
      if (rule.skip_repeats !== 0) {
        if (p.episode_num && db.get("SELECT 1 FROM recordings r JOIN programs pp ON pp.id = r.program_id WHERE r.rule_id = ? AND pp.episode_num = ? AND pp.title = ? AND r.status IN ('completed','scheduled','recording')", rule.id, p.episode_num, p.title)) continue;
        if (!p.episode_num && p.subtitle && db.get("SELECT 1 FROM recordings WHERE rule_id = ? AND title = ? AND status IN ('completed','scheduled','recording')", rule.id, `${p.title} - ${p.subtitle}`)) continue;
      }
      try {
        const owner = db.get('SELECT * FROM users WHERE id = ?', rule.created_by);
        // A rule left behind by a deleted account must not keep recording with admin rights.
        if (!owner) break;
        scheduleRecording({ id: rule.created_by, displayName: owner.display_name ?? 'DVR', isAdmin: true } as User,
          { channelId: ch.id, programId: p.id, paddingBeforeMin: rule.padding_before, paddingAfterMin: rule.padding_after }, rule.id, rule.priority ?? 50);
      } catch (e) {
        log.debug(`Rule ${rule.title_match}: ${(e as Error).message}`);
      }
    }
  }
}

bus.on('epg.refreshed', () => applyRules());

homeHooks.recordingsRow = (user, cfg): HomeRow | null => {
  if (!getBranding().features.dvr) return null;
  const rows = db.all("SELECT item_id FROM recordings WHERE status = 'completed' AND item_id IS NOT NULL ORDER BY start DESC LIMIT ?", cfg.limit ?? 20);
  // One query for the whole row (hidden or deleted items are skipped, as before).
  const items = itemsByIds(user, rows.map((r) => r.item_id));
  return items.length ? { id: cfg.id, type: 'recordings', title: cfg.title ?? 'Recordings', items } : null;
};
