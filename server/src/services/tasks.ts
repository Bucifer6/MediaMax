import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ScheduledTask } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { getKv, setKv, getSettings } from './settings.js';
import { events } from './events.js';
import { logger } from '../util/log.js';
import { notFound } from '../util/errors.js';
import { scanLibrary } from './scanner.js';
import { refreshDueSources, refreshSource, pruneOldPrograms } from './livetv/livetv.js';
import { pruneActivity } from './activity.js';
import { pruneImageCache, registerImage } from './images.js';
import { reapSessions, listSessions } from './playback.js';
import { tick as dvrTick, applyRules } from './dvr.js';
import { detectAll } from './introdetect.js';
import { enrichLibrary } from './metadata/index.js';
import { syncWatchers } from './watcher.js';
import { generateMissing } from './trickplay.js';
import { pluginTasks } from './plugins.js';
import { createBackup } from './backup.js';
import { analyseAll } from './dj/analysis.js';
import { pruneVoices } from './dj/ai.js';
import { autoDownload } from './opensubtitles.js';
import { refreshAll as refreshPodcasts } from './podcasts.js';
import { checkAvailability } from './requests.js';
import { refreshSchedules } from './calendar.js';

const log = logger('tasks');

interface TaskDef {
  id: string;
  name: string;
  description: string;
  interval: () => number | null; // minutes
  run: (progress: (p: number) => void) => Promise<void>;
}

interface TaskState {
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastResult: 'ok' | 'error' | null;
  lastError: string | null;
}

function grabThumb(file: string, atSec: number, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(config.ffmpeg, ['-v', 'error', '-y', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '4', dest]);
    p.on('error', () => resolve(false));
    p.on('exit', (c) => resolve(c === 0 && fs.existsSync(dest)));
  });
}

const DEFS: TaskDef[] = [
  {
    id: 'scan-libraries', name: 'Scan all libraries', description: 'Look for new, changed and removed media in every library.',
    interval: () => getSettings().scanIntervalMinutes || null,
    run: async (progress) => {
      const libs = db.all<{ id: string; type: string }>("SELECT id, type FROM libraries WHERE type NOT LIKE 'iptv-%'");
      for (let i = 0; i < libs.length; i++) {
        await scanLibrary(libs[i].id);
        progress(Math.round(((i + 1) / libs.length) * 100));
      }
    },
  },
  {
    id: 'refresh-livetv', name: 'Refresh Live TV & IPTV', description: 'Refresh channels, EPG guide data and Xtream VOD/series catalogues when due.',
    interval: () => 30,
    run: async () => refreshDueSources(),
  },
  {
    id: 'refresh-livetv-all', name: 'Force refresh all Live TV sources', description: 'Re-download every playlist, catalogue and guide now.',
    interval: () => null,
    run: async (progress) => {
      const s = db.all<{ id: string }>('SELECT id FROM live_sources WHERE enabled = 1');
      for (let i = 0; i < s.length; i++) {
        await refreshSource(s[i].id);
        progress(Math.round(((i + 1) / s.length) * 100));
      }
    },
  },
  {
    id: 'refresh-metadata', name: 'Refresh all metadata', description: 'Re-fetch posters, artwork, cast and descriptions from TMDB for every movie and show.',
    interval: () => null,
    run: async (progress) => {
      const libs = db.all<{ id: string }>("SELECT id FROM libraries WHERE type IN ('movies','shows') AND fetch_metadata = 1");
      for (let i = 0; i < libs.length; i++) {
        await enrichLibrary(libs[i].id, { refresh: true });
        progress(Math.round(((i + 1) / libs.length) * 100));
      }
    },
  },
  {
    id: 'detect-intros', name: 'Detect intros & credits', description: 'Audio-fingerprint TV episodes to find intros and end credits for Skip buttons.',
    interval: () => 24 * 60,
    run: async (progress) => {
      const n = await detectAll(progress);
      log.info(`Intro detection updated ${n} episode(s)`);
    },
  },
  {
    id: 'episode-thumbnails', name: 'Generate missing thumbnails', description: 'Extract preview images for episodes and videos that have none.',
    interval: () => 12 * 60,
    run: async (progress) => {
      const rows = db.all(`SELECT i.id, m.path, m.duration_ms FROM items i JOIN media m ON m.item_id = i.id
        WHERE i.type IN ('episode','video') AND i.thumb IS NULL AND m.path IS NOT NULL AND m.duration_ms > 0 GROUP BY i.id LIMIT 2000`);
      const dir = path.join(config.cacheDir, 'thumbs');
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const dest = path.join(dir, `${r.id}.jpg`);
        if (fs.existsSync(dest) || (await grabThumb(r.path, Math.round((r.duration_ms / 1000) * 0.2), dest))) {
          db.run('UPDATE items SET thumb = ? WHERE id = ?', registerImage(dest), r.id);
        }
        if (i % 10 === 0) progress(Math.round(((i + 1) / rows.length) * 100));
      }
    },
  },
  {
    id: 'trickplay', name: 'Generate scrub previews', description: 'Build seek-bar preview thumbnails (trickplay) for movies and episodes. Enable in Settings → Trickplay.',
    interval: () => (getSettings().trickplay.enabled ? 6 * 60 : null),
    run: async (progress) => {
      const n = await generateMissing(progress);
      log.info(`Trickplay generated for ${n} file(s)`);
    },
  },
  {
    id: 'subtitles', name: 'Download missing subtitles', description: 'Fetch subtitles from OpenSubtitles in your preferred languages for recent media.',
    interval: () => (getSettings().openSubtitles.apiKey && getSettings().openSubtitles.autoLanguages.length ? 12 * 60 : null),
    run: async (progress) => {
      const n = await autoDownload(progress);
      log.info(`Downloaded ${n} subtitle file(s)`);
    },
  },
  {
    id: 'podcasts', name: 'Refresh podcasts', description: 'Check subscribed podcast feeds for new episodes (and download them when auto-download is on).',
    interval: () => 60,
    run: async (progress) => {
      const n = await refreshPodcasts(progress);
      if (n) log.info(`${n} new podcast episode(s)`);
    },
  },
  {
    id: 'requests', name: 'Check requested titles', description: 'Mark approved requests as available once they arrive in a library.',
    interval: () => 30,
    run: async () => {
      const n = checkAvailability();
      if (n) log.info(`${n} request(s) now available`);
    },
  },
  {
    id: 'tv-schedules', name: 'Refresh TV schedules', description: 'Fetch the next airing episode of each show from TMDB for the calendar and the Coming Soon row.',
    interval: () => 24 * 60,
    run: async (progress) => {
      const n = await refreshSchedules(progress);
      if (n) log.info(`Refreshed the schedule of ${n} show(s)`);
    },
  },
  {
    id: 'dvr-rules', name: 'Apply series recording rules', description: 'Schedule upcoming programmes that match your series recording rules.',
    interval: () => 60,
    run: async () => applyRules(),
  },
  {
    id: 'dj-analysis', name: 'Analyse music for DJ mode', description: 'Detect tempo (BPM), musical key, energy and mix points of new or changed tracks.',
    interval: () => 6 * 60,
    run: async (progress) => {
      await analyseAll(progress);
    },
  },
  {
    id: 'backup', name: 'Back up server', description: 'Snapshot the database, branding, artwork, avatars, plugins and subtitles (Admin → Backups).',
    interval: () => (getSettings().backups.intervalDays > 0 ? getSettings().backups.intervalDays * 24 * 60 : null),
    run: async () => {
      createBackup('scheduled');
    },
  },
  {
    id: 'cleanup', name: 'Clean up', description: 'Prune old activity, guide data, cached images and stale transcode files.',
    interval: () => 24 * 60,
    run: async () => {
      pruneActivity();
      pruneOldPrograms();
      pruneImageCache();
      pruneVoices();
      const active = new Set(listSessions().map((s) => s.id));
      for (const d of fs.readdirSync(config.transcodeDir)) {
        const p = path.join(config.transcodeDir, d);
        try {
          if (Date.now() - fs.statSync(p).mtimeMs > 6 * 3600000 && !active.has(d)) fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      db.exec('PRAGMA optimize');
    },
  },
];

const running = new Map<string, number>(); // id -> progress

function state(id: string): TaskState {
  return getKv<TaskState>(`task:${id}`, { lastRunAt: null, lastDurationMs: null, lastResult: null, lastError: null });
}

function toTask(d: TaskDef): ScheduledTask {
  const s = state(d.id);
  return { id: d.id, name: d.name, description: d.description, intervalMinutes: d.interval(), ...s, running: running.has(d.id), progress: running.get(d.id) ?? null };
}

/** Built-in tasks plus tasks registered by active plugins. */
const allDefs = (): TaskDef[] => [
  ...DEFS,
  ...pluginTasks().map((t) => ({ id: t.id, name: t.name, description: t.description ?? 'Plugin task', interval: () => t.intervalMinutes ?? null, run: t.run })),
];

export const listTasks = () => allDefs().map(toTask);

export async function runTask(id: string): Promise<void> {
  const d = allDefs().find((x) => x.id === id);
  if (!d) throw notFound('Task not found');
  if (running.has(id)) return;
  running.set(id, 0);
  events.toAdmins({ type: 'task.updated', task: toTask(d) });
  const started = Date.now();
  let lastEmit = 0;
  try {
    await d.run((p) => {
      running.set(id, p);
      if (Date.now() - lastEmit > 1000) {
        lastEmit = Date.now();
        events.toAdmins({ type: 'task.updated', task: toTask(d) });
      }
    });
    setKv(`task:${id}`, { lastRunAt: new Date().toISOString(), lastDurationMs: Date.now() - started, lastResult: 'ok', lastError: null });
  } catch (e) {
    log.error(`Task ${id} failed`, e);
    setKv(`task:${id}`, { lastRunAt: new Date().toISOString(), lastDurationMs: Date.now() - started, lastResult: 'error', lastError: (e as Error).message });
  } finally {
    running.delete(id);
    events.toAdmins({ type: 'task.updated', task: toTask(d) });
  }
}

let timers: NodeJS.Timeout[] = [];

export function startScheduler() {
  // Fast housekeeping loops.
  timers.push(setInterval(() => void dvrTick().catch((e) => log.error('DVR tick failed', e)), 15000));
  timers.push(setInterval(() => reapSessions(), 30000));
  if (process.env.MEDIAMAX_NO_WATCH !== '1') {
    syncWatchers();
    timers.push(setInterval(() => syncWatchers(), 60000));
  }
  // Interval tasks: check every minute which are due.
  const check = () => {
    for (const d of allDefs()) {
      const iv = d.interval();
      if (!iv || running.has(d.id)) continue;
      const last = state(d.id).lastRunAt;
      if (!last || Date.now() - Date.parse(last) > iv * 60000) void runTask(d.id);
    }
  };
  // Give the server a moment to boot before heavy work.
  timers.push(setTimeout(check, 20000));
  timers.push(setInterval(check, 60000));
}

export function stopScheduler() {
  timers.forEach((t) => clearInterval(t));
  timers = [];
}
