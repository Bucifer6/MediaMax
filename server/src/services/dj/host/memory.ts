/**
 * The host's anti-repeat memory: phrases, jokes and facts already used. Per session in memory (never repeat within a
 * listening session) and per user in the database for a few days (jokes 5 days, facts 3, phrases 1), plus the times
 * of recent breaks (full breaks per hour, last time / weather check).
 */
import { db } from '../../../db.js';

const DAYS: Record<string, number> = { joke: 5, fact: 3, phrase: 1, break: 1, time: 1, weather: 1 };
let lastPrune = 0;

export function used(userId: string, kind: string, key: string, days = DAYS[kind] ?? 3): boolean {
  return !!db.get('SELECT 1 FROM dj_host_log WHERE user_id = ? AND kind = ? AND key = ? AND at > ? LIMIT 1', userId, kind, key, new Date(Date.now() - days * 86400000).toISOString());
}

export function usedKeys(userId: string, kind: string, days = DAYS[kind] ?? 3): Set<string> {
  return new Set(db.all<{ key: string }>('SELECT key FROM dj_host_log WHERE user_id = ? AND kind = ? AND at > ?', userId, kind, new Date(Date.now() - days * 86400000).toISOString()).map((r) => r.key));
}

export function remember(userId: string, kind: string, key: string) {
  db.run('INSERT INTO dj_host_log (user_id, kind, key, at) VALUES (?, ?, ?, ?)', userId, kind, key.slice(0, 300), new Date().toISOString());
  if (Date.now() - lastPrune > 3600000) {
    lastPrune = Date.now();
    db.run('DELETE FROM dj_host_log WHERE at < ?', new Date(Date.now() - 7 * 86400000).toISOString());
  }
}

/** How many entries of `kind` in the last `ms`. */
export function countSince(userId: string, kind: string, ms: number): number {
  return db.get<{ n: number }>('SELECT COUNT(*) n FROM dj_host_log WHERE user_id = ? AND kind = ? AND at > ?', userId, kind, new Date(Date.now() - ms).toISOString())!.n;
}

/** Most recent entry time of `kind` (ms epoch), 0 if none. */
export function lastAt(userId: string, kind: string): number {
  const r = db.get<{ at: string | null }>('SELECT MAX(at) at FROM dj_host_log WHERE user_id = ? AND kind = ?', userId, kind);
  return r?.at ? Date.parse(r.at) : 0;
}

// Session-scoped: every sentence said in this listening session (radio: per user, reset after 6 h idle).
const sessions = new Map<string, { said: Set<string>; at: number }>();
export function sessionSaid(key: string): Set<string> {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.at > 6 * 3600000) sessions.delete(k);
  let s = sessions.get(key);
  if (!s) sessions.set(key, (s = { said: new Set(), at: now }));
  s.at = now;
  return s.said;
}

/** Tests. */
export function resetHostMemory() {
  sessions.clear();
  db.run('DELETE FROM dj_host_log');
}
