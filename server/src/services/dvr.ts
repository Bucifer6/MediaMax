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
import { accessibleChannelRow, channelStreamUrl, channelUserAgent, trackUpstream } from './livetv/livetv.js';
import { effEpg } from './livetv/epg/epg.js';
import { scanLibrary } from './scanner.js';
import { homeHooks, getItem } from './items.js';
import { getBranding } from './branding.js';

const log = logger('dvr');

function toRecording(r: Row): Recording {
  return {
    id: r.id, channelId: r.channel_id, channelName: r.channel_name, programId: r.program_id ?? null, title: r.title, description: r.description ?? null,
    start: r.start, end: r.end, status: r.status, itemId: r.item_id ?? null, ruleId: r.rule_id ?? null, error: r.error ?? null, sizeBytes: r.size_bytes ?? null, createdBy: r.created_by,
    priority: r.priority ?? 100, conflict: !!r.conflict,
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
  const p = active.get(id);
  if (p) {
    p.kill('SIGINT');
    db.run("UPDATE recordings SET status = 'cancelled' WHERE id = ?", id);
  } else if (r.status === 'scheduled') {
    db.run("UPDATE recordings SET status = 'cancelled' WHERE id = ?", id);
  } else {
    // Completed/failed: delete file + item.
    if (r.path) fs.rmSync(r.path, { force: true }), fs.rmSync(edlPathFor(r.path), { force: true });
    if (r.item_id) db.run('DELETE FROM items WHERE id = ?', r.item_id);
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

function startRecording(r: Row) {
  const ch = db.get('SELECT * FROM channels WHERE id = ?', r.channel_id);
  if (!ch) {
    db.run("UPDATE recordings SET status = 'failed', error = 'Channel no longer exists' WHERE id = ?", r.id);
    emit(r.id);
    return;
  }
  const dir = path.join(getSettings().dvr.recordingsPath, safe(r.title.split(' - ')[0]));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(r.start).toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
  const file = path.join(dir, `${safe(r.title)} (${stamp}).ts`);
  const durationSec = Math.max(10, Math.round((Date.parse(r.end) - Date.now()) / 1000));
  const url = channelStreamUrl(ch);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-user_agent', channelUserAgent(ch), '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
    ...REMOTE_PROTOCOLS, '-i', url, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-t', String(durationSec), '-f', 'mpegts', file];
  log.info(`Recording "${r.title}" for ${durationSec}s → ${file}`);
  const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
  active.set(r.id, p);
  trackUpstream(ch.source_id, 1);
  db.run("UPDATE recordings SET status = 'recording', path = ? WHERE id = ?", file, r.id);
  emit(r.id);
  p.on('exit', async (code) => {
    active.delete(r.id);
    trackUpstream(ch.source_id, -1);
    const cur = db.get('SELECT status FROM recordings WHERE id = ?', r.id);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size > 100_000) {
      db.run("UPDATE recordings SET status = ?, size_bytes = ?, error = ? WHERE id = ?", cur?.status === 'cancelled' ? 'cancelled' : 'completed', size, code === 0 ? null : err.trim().slice(-300) || null, r.id);
      const libId = ensureRecordingsLibrary(getSettings().dvr.recordingsPath);
      if (await runComskip(file)) log.info(`Commercial markers found for "${r.title}"`);
      await scanLibrary(libId);
      const item = db.get('SELECT i.id FROM items i JOIN media m ON m.item_id = i.id WHERE m.path = ?', file);
      if (item) db.run('UPDATE items SET overview = COALESCE(overview, ?), title = ? WHERE id = ?', r.description, r.title, item.id), db.run('UPDATE recordings SET item_id = ? WHERE id = ?', item.id, r.id);
      logActivity('dvr.complete', `Recording finished: ${r.title}`);
      bus.emit('recording.completed', toRecording(db.get('SELECT * FROM recordings WHERE id = ?', r.id)!));
      enforceKeepLatest(r.rule_id);
    } else {
      fs.rmSync(file, { force: true });
      db.run("UPDATE recordings SET status = 'failed', error = ? WHERE id = ?", err.trim().slice(-300) || `ffmpeg exited with ${code}`, r.id);
      logActivity('dvr.failed', `Recording failed: ${r.title}`, { severity: 'error' });
      bus.emit('recording.failed', toRecording(db.get('SELECT * FROM recordings WHERE id = ?', r.id)!));
    }
    emit(r.id);
  });
}

function enforceKeepLatest(ruleId: string | null) {
  if (!ruleId) return;
  const rule = db.get('SELECT * FROM recording_rules WHERE id = ?', ruleId);
  if (!rule?.keep_latest) return;
  const done = db.all("SELECT * FROM recordings WHERE rule_id = ? AND status = 'completed' ORDER BY start DESC", ruleId);
  for (const old of done.slice(rule.keep_latest)) {
    if (old.path) fs.rmSync(old.path, { force: true });
    if (old.item_id) db.run('DELETE FROM items WHERE id = ?', old.item_id);
    db.run('DELETE FROM recordings WHERE id = ?', old.id);
  }
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
  // Recordings marked 'recording' but no process (server restart) → failed or completed.
  for (const r of db.all("SELECT * FROM recordings WHERE status = 'recording'")) {
    if (!active.has(r.id)) {
      if (r.end > now) startRecording({ ...r, title: r.title + ' (resumed)' });
      else db.run("UPDATE recordings SET status = ? WHERE id = ?", r.path && fs.existsSync(r.path) ? 'completed' : 'failed', r.id);
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
        scheduleRecording({ id: rule.created_by, displayName: owner?.display_name ?? 'DVR', isAdmin: true } as User,
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
  const items = rows.map((r) => {
    try {
      return getItem(user, r.item_id, false);
    } catch {
      return null;
    }
  }).filter((x): x is NonNullable<typeof x> => !!x);
  return items.length ? { id: cfg.id, type: 'recordings', title: cfg.title ?? 'Recordings', items } : null;
};
