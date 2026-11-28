import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DashboardStats, DirectoryEntry, ServerSettings, SetupRequest, SystemInfo } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, deviceFromRequest, remoteAddr, noCache } from '../http.js';
import { getSettings, updateSettings, serverId, publicSettings } from '../services/settings.js';
import { getBranding, updateBranding } from '../services/branding.js';
import { createUserHashed, hashUserSecrets, issueToken, userCount } from '../services/auth.js';
import { listSessions, transcodeCount } from '../services/playback.js';
import { listTasks, runTask } from '../services/tasks.js';
import { listActivity, logActivity } from '../services/activity.js';
import { sendWebhook } from '../services/webhooks.js';
import { syncDlna } from '../services/dlna.js';
import { oidcEnabled } from '../services/oidc.js';
import * as backup from '../services/backup.js';
import * as remote from '../services/remote.js';
import * as updates from '../services/updates.js';
import { mappedDrives, networkPathHint, serverAccount, statWithin } from '../util/winpaths.js';
import { recentLogLines } from '../util/log.js';
import { badRequest, forbidden } from '../util/errors.js';
import { toInt } from '../util/misc.js';

export default async function systemRoutes(app: FastifyInstance) {
  app.get('/system/info', async (_req, reply): Promise<SystemInfo> => {
    noCache(reply);
    return { id: serverId(), name: getBranding().serverName, version: config.version, setupRequired: userCount() === 0, publicUrl: getSettings().publicUrl, features: getBranding().features,
      oidc: oidcEnabled() ? { enabled: true, buttonLabel: getSettings().oidc.buttonLabel || 'Sign in with SSO' } : null };
  });

  app.post<{ Body: SetupRequest }>('/setup', async (req) => {
    if (userCount() > 0) throw forbidden('Setup has already been completed');
    const b = req.body ?? ({} as SetupRequest);
    if (!b.username || !b.password) throw badRequest('Username and password are required');
    const req2 = { username: b.username, password: b.password, isAdmin: true, allowDvr: true };
    const hashes = await hashUserSecrets(req2);
    // Re-checked after the await: two racing setup requests must not both create an administrator.
    if (userCount() > 0) throw forbidden('Setup has already been completed');
    const user = createUserHashed(req2, hashes);
    if (b.serverName) {
      updateSettings({ serverName: b.serverName });
      updateBranding({ serverName: b.serverName });
    }
    logActivity('setup', `Server set up by ${user.displayName}`);
    return issueToken(user.id, deviceFromRequest(req, req.body as any), remoteAddr(req) ?? undefined);
  });

  app.get('/system/stats', async (req): Promise<DashboardStats> => {
    requireAdmin(req);
    const count = (t: string) => db.get<{ n: number }>(`SELECT COUNT(*) n FROM items WHERE type = ?`, t)!.n;
    let diskFree: number | null = null;
    try {
      const st = fs.statfsSync(config.dataDir);
      diskFree = st.bavail * st.bsize;
    } catch {
      /* unsupported */
    }
    return {
      libraries: db.get<{ n: number }>('SELECT COUNT(*) n FROM libraries')!.n,
      movies: count('movie'), shows: count('show'), episodes: count('episode'), tracks: count('track'),
      channels: db.get<{ n: number }>('SELECT COUNT(*) n FROM channels')!.n,
      users: userCount(), activeSessions: listSessions().length, transcodes: transcodeCount(),
      recordingsScheduled: db.get<{ n: number }>("SELECT COUNT(*) n FROM recordings WHERE status IN ('scheduled','recording')")!.n,
      diskFreeBytes: diskFree, version: config.version, uptimeSeconds: Math.round((Date.now() - config.startedAt) / 1000),
    };
  });

  app.get<{ Querystring: { path?: string } }>('/system/browse', async (req): Promise<DirectoryEntry[]> => {
    requireAdmin(req);
    // Windows has no single root: with no path, list the drives (the picker goes "up" from C:\ to here).
    if (!req.query.path && process.platform === 'win32') return listWindowsDrives();
    const abs = path.resolve(req.query.path || '/');
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch (e) {
      throw badRequest(`Cannot open ${abs}: ${(e as Error).message}.${networkPathHint(abs)}`);
    }
    const out: DirectoryEntry[] = [];
    if (path.dirname(abs) !== abs) out.push({ name: '..', path: path.dirname(abs), isDirectory: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(abs, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = (await fs.promises.stat(full)).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) out.push({ name: e.name, path: full, isDirectory: true });
    }
    return out;
  });

  app.get<{ Querystring: { lines?: string } }>('/system/logs', async (req) => {
    requireAdmin(req);
    return { lines: recentLogLines(toInt(req.query.lines, 500, 1, 2000)) };
  });

  app.get('/settings', async (req): Promise<ServerSettings> => {
    requireAdmin(req);
    return publicSettings();
  });
  app.put<{ Body: Partial<ServerSettings> }>('/settings', async (req) => {
    const a = requireAdmin(req);
    const s = updateSettings(req.body ?? {});
    syncDlna();
    if (req.body?.remoteAccess) void remote.refreshMapping();
    if (req.body?.serverName) updateBranding({ serverName: req.body.serverName });
    logActivity('settings', 'Server settings updated', { userId: a.user.id, userName: a.user.displayName });
    return publicSettings(s);
  });
  app.post<{ Body: { url: string } }>('/settings/webhooks/test', async (req) => {
    requireAdmin(req);
    if (!req.body?.url) throw badRequest('URL required');
    return sendWebhook(req.body.url, { event: 'test', at: new Date().toISOString(), server: { id: serverId(), name: getSettings().serverName } });
  });

  /* Backups */
  app.get('/admin/backups', async (req) => {
    requireAdmin(req);
    return backup.listBackups();
  });
  app.post('/admin/backups', async (req) => backup.createBackup('manual', requireAdmin(req).user));
  app.get<{ Params: { id: string } }>('/admin/backups/:id/download', async (req, reply) => {
    requireAdmin(req);
    const p = backup.backupPath(req.params.id);
    reply.header('Content-Type', 'application/gzip').header('Content-Disposition', `attachment; filename="${req.params.id}"`);
    return fs.createReadStream(p);
  });
  app.delete<{ Params: { id: string } }>('/admin/backups/:id', async (req) => {
    requireAdmin(req);
    backup.deleteBackup(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/admin/backups/:id/restore', async (req) => {
    // Authorise before touching the file: no existence oracle, and no reading a multi-GB backup for anonymous callers.
    const a = requireAdmin(req);
    return backup.stageRestore(fs.readFileSync(backup.backupPath(req.params.id)), a.user);
  });
  app.post('/admin/backups/restore-upload', async (req) => {
    const a = requireAdmin(req);
    const file = await req.file({ limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
    if (!file) throw badRequest('Upload a Vibe backup (.tar.gz)');
    return backup.stageRestore(await file.toBuffer(), a.user);
  });
  /** Exit so the supervisor (Docker restart policy / systemd) starts Vibe again. */
  app.post('/admin/restart', async (req) => {
    const a = requireAdmin(req);
    logActivity('server', 'Restart requested', { userId: a.user.id, userName: a.user.displayName, severity: 'warning' });
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
    return { ok: true };
  });

  /* Server updates (Admin → Updates) */
  app.get('/admin/updates', async (req) => {
    requireAdmin(req);
    return updates.updateStatus();
  });
  app.post('/admin/updates/check', async (req) => {
    requireAdmin(req);
    return updates.checkForUpdates();
  });
  app.post('/admin/updates/install', async (req) => {
    const a = requireAdmin(req);
    return updates.installUpdate(a.user);
  });

  /* Remote access */
  app.get('/admin/remote-access', async (req) => {
    requireAdmin(req);
    return remote.remoteStatus();
  });
  app.post('/admin/remote-access/refresh', async (req) => {
    requireAdmin(req);
    await remote.refreshMapping();
    return remote.remoteStatus();
  });

  /* Prometheus-style metrics (admin auth or API key). */
  app.get('/metrics', async (req, reply) => {
    requireAdmin(req);
    const count = (sql: string) => db.get<{ n: number }>(sql)!.n;
    const sessions = listSessions();
    const lines = [
      '# HELP mediamax_up 1 if the server is running', '# TYPE mediamax_up gauge', 'mediamax_up 1',
      `mediamax_uptime_seconds ${Math.round((Date.now() - config.startedAt) / 1000)}`,
      `mediamax_sessions_active ${sessions.length}`,
      `mediamax_transcodes_active ${transcodeCount()}`,
      ...['movie', 'show', 'episode', 'track', 'audiobook', 'podcastepisode'].map((t) => `mediamax_items{type="${t}"} ${count(`SELECT COUNT(*) n FROM items WHERE type = '${t}'`)}`),
      `mediamax_users ${userCount()}`,
      `mediamax_channels ${count('SELECT COUNT(*) n FROM channels')}`,
      `mediamax_recordings_scheduled ${count("SELECT COUNT(*) n FROM recordings WHERE status IN ('scheduled','recording')")}`,
      `mediamax_requests_pending ${count("SELECT COUNT(*) n FROM media_requests WHERE status = 'pending'")}`,
    ];
    reply.type('text/plain; version=0.0.4');
    return lines.join('\n') + '\n';
  });

  app.get('/tasks', async (req) => {
    requireAdmin(req);
    return listTasks();
  });
  app.post<{ Params: { id: string } }>('/tasks/:id/run', async (req) => {
    requireAdmin(req);
    void runTask(req.params.id);
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>('/activity', async (req) => {
    requireAdmin(req);
    return listActivity(toInt(req.query.limit, 50, 1, 500), toInt(req.query.offset, 0, 0));
  });
}

/**
 * Windows' top level: the drives present right now (local, and removable ones with media inserted), then the
 * network drives mapped by this account or any signed-in user, offered as their \\server\share path so they
 * work whichever account Vibe runs as.
 */
async function listWindowsDrives(): Promise<DirectoryEntry[]> {
  const mapped = await mappedDrives().catch(() => []);
  const mappedLetters = new Set(mapped.map((m) => m.letter));
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((l) => !mappedLetters.has(l));
  const found = await Promise.all(letters.map(async (l) => {
    const root = `${l}:\\`;
    return (await statWithin(root, 2000))?.isDirectory() ? root : null;
  }));
  const drives: DirectoryEntry[] = found.filter((r): r is string => r !== null).map((r) => ({ name: r, path: r, isDirectory: true, kind: 'drive' }));
  const account = serverAccount();
  const network = await Promise.all(mapped.map(async (m): Promise<DirectoryEntry> => {
    const ok = (await statWithin(m.remotePath))?.isDirectory() ?? false;
    return {
      name: `${m.letter}: ${m.remotePath}`, path: m.remotePath, isDirectory: true, kind: 'network',
      error: ok ? null : account === 'SYSTEM'
        ? 'Vibe runs as SYSTEM, which this share refuses. Run setup again and choose a Windows account for the service.'
        : `Vibe runs as ${account}, which can't open this share. Check that account can open it in File Explorer.`,
    };
  }));
  return [...drives, ...network];
}
