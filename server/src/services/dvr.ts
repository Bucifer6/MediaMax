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
import { getSettings } from './settings.js';
import { events, bus } from './events.js';
import { logActivity } from './activity.js';
import { channelStreamUrl, channelUserAgent, trackUpstream } from './livetv/livetv.js';
import { scanLibrary } from './scanner.js';
import { homeHooks, getItem } from './items.js';
import { getBranding } from './branding.js';

const log = logger('dvr');

function toRecording(r: Row): Recording {
  return {
    id: r.id, channelId: r.channel_id, channelName: r.channel_name, programId: r.program_id ?? null, title: r.title, description: r.description ?? null,
    start: r.start, end: r.end, status: r.status, itemId: r.item_id ?? null, ruleId: r.rule_id ?? null, error: r.error ?? null, sizeBytes: r.size_bytes ?? null, createdBy: r.created_by,
  };
}
const toRule = (r: Row): RecordingRule => ({
  id: r.id, titleMatch: r.title_match, channelId: r.channel_id ?? null, newOnly: !!r.new_only, keepLatest: r.keep_latest ?? null,
  paddingBeforeMin: r.padding_before, paddingAfterMin: r.padding_after, enabled: !!r.enabled,
});

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

export function scheduleRecording(user: User, req: CreateRecordingRequest, ruleId: string | null = null): Recording {
  if (ruleId === null) assertDvr(user);
  const ch = db.get('SELECT * FROM channels WHERE id = ?', req.channelId);
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
  start = new Date(start.getTime() - (req.paddingBeforeMin ?? s.paddingBeforeMin) * 60000);
  end = new Date(end.getTime() + (req.paddingAfterMin ?? s.paddingAfterMin) * 60000);
  if (end.getTime() <= Date.now()) throw badRequest('That programme has already finished');
  if (end <= start) throw badRequest('End must be after start');
  const id = newId();
  db.insert('recordings', {
    id, channel_id: ch.id, channel_name: custom.name ?? ch.name, program_id: req.programId ?? null, title: title || `${custom.name ?? ch.name} recording`,
    description, start: start.toISOString(), end: end.toISOString(), status: 'scheduled', rule_id: ruleId, created_by: user.id, created_at: nowIso(),
  });
  logActivity('dvr.schedule', `Recording scheduled: ${title} on ${ch.name}`, { userId: user.id, userName: user.displayName });
  emit(id);
  void tick();
  return toRecording(db.get('SELECT * FROM recordings WHERE id = ?', id)!);
}

const active = new Map<string, ChildProcess>();

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
    if (r.path) fs.rmSync(r.path, { force: true });
    if (r.item_id) db.run('DELETE FROM items WHERE id = ?', r.item_id);
    db.run('DELETE FROM recordings WHERE id = ?', id);
    return;
  }
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
  for (const r of db.all("SELECT * FROM recordings WHERE status = 'scheduled' AND start <= ? AND end > ?", now, now)) {
    if (!active.has(r.id)) startRecording(r);
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

export function listRules(user: User): RecordingRule[] {
  assertDvr(user);
  return db.all('SELECT * FROM recording_rules ORDER BY title_match').map(toRule);
}

export function createRule(user: User, req: CreateRecordingRuleRequest): RecordingRule {
  assertDvr(user);
  if (!req.titleMatch?.trim()) throw badRequest('Title match is required');
  const id = newId();
  const s = getSettings().dvr;
  db.insert('recording_rules', {
    id, title_match: req.titleMatch.trim(), channel_id: req.channelId ?? null, new_only: !!req.newOnly, keep_latest: req.keepLatest ?? null,
    padding_before: req.paddingBeforeMin ?? s.paddingBeforeMin, padding_after: req.paddingAfterMin ?? s.paddingAfterMin, enabled: req.enabled ?? true, created_by: user.id,
  });
  applyRules();
  return toRule(db.get('SELECT * FROM recording_rules WHERE id = ?', id)!);
}

export function updateRule(user: User, id: string, req: Partial<CreateRecordingRuleRequest>): RecordingRule {
  assertDvr(user);
  const r = db.get('SELECT * FROM recording_rules WHERE id = ?', id);
  if (!r) throw notFound('Rule not found');
  const p: Row = {};
  if (req.titleMatch !== undefined) p.title_match = req.titleMatch;
  if (req.channelId !== undefined) p.channel_id = req.channelId;
  if (req.newOnly !== undefined) p.new_only = req.newOnly;
  if (req.keepLatest !== undefined) p.keep_latest = req.keepLatest;
  if (req.paddingBeforeMin !== undefined) p.padding_before = req.paddingBeforeMin;
  if (req.paddingAfterMin !== undefined) p.padding_after = req.paddingAfterMin;
  if (req.enabled !== undefined) p.enabled = req.enabled;
  db.update('recording_rules', id, p);
  applyRules();
  return toRule(db.get('SELECT * FROM recording_rules WHERE id = ?', id)!);
}

export function deleteRule(user: User, id: string) {
  assertDvr(user);
  db.run('DELETE FROM recording_rules WHERE id = ?', id);
  db.run("UPDATE recordings SET status = 'cancelled' WHERE rule_id = ? AND status = 'scheduled'", id);
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
      const e = parseJson<any>(c.custom, {}).epgChannelId ?? c.epg_channel_id;
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
      if (p.episode_num && db.get("SELECT 1 FROM recordings r JOIN programs pp ON pp.id = r.program_id WHERE r.rule_id = ? AND pp.episode_num = ? AND pp.title = ? AND r.status IN ('completed','scheduled','recording')", rule.id, p.episode_num, p.title)) continue;
      try {
        const owner = db.get('SELECT * FROM users WHERE id = ?', rule.created_by);
        scheduleRecording({ id: rule.created_by, displayName: owner?.display_name ?? 'DVR', isAdmin: true } as User,
          { channelId: ch.id, programId: p.id, paddingBeforeMin: rule.padding_before, paddingAfterMin: rule.padding_after }, rule.id);
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
