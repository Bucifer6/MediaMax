import type { ActivityEntry, Paged } from '@mediamax/shared';
import { db } from '../db.js';
import { nowIso } from '../util/misc.js';

export function logActivity(type: string, message: string, opts: { userId?: string | null; userName?: string | null; severity?: ActivityEntry['severity'] } = {}) {
  db.insert('activity', { at: nowIso(), user_id: opts.userId ?? null, user_name: opts.userName ?? null, type, message, severity: opts.severity ?? 'info' });
}

export function listActivity(limit: number, offset: number): Paged<ActivityEntry> {
  const rows = db.all('SELECT * FROM activity ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset);
  const total = db.get<{ n: number }>('SELECT COUNT(*) n FROM activity')!.n;
  return {
    items: rows.map((r) => ({ id: String(r.id), at: r.at, userId: r.user_id, userName: r.user_name, type: r.type, message: r.message, severity: r.severity })),
    total, limit, offset,
  };
}

export function pruneActivity(keepDays = 60) {
  db.run('DELETE FROM activity WHERE at < ?', new Date(Date.now() - keepDays * 86400000).toISOString());
}
