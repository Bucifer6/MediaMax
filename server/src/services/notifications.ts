/**
 * In-app notifications. New episodes of a show a viewer watches (or has on My List) create one notification per
 * show per scan, pushed live over the WebSocket as a `notification` event.
 */
import type { AppNotification, NotificationKind, NotificationsResponse, User } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { events, bus } from './events.js';
import { accessClause } from './items.js';
import { getUser } from './auth.js';
import { imageUrl } from './images.js';
import { newId } from '../util/ids.js';
import { nowIso, toInt } from '../util/misc.js';
import { logger } from '../util/log.js';

const log = logger('notifications');
/** Keep at most this many notifications per user. */
const KEEP = 200;

function toNotification(r: Row): AppNotification {
  return {
    id: r.id, kind: r.kind, itemId: r.item_id ?? null, title: r.title, body: r.body ?? null,
    imageUrl: imageUrl(r.img ?? null), createdAt: r.created_at, readAt: r.read_at ?? null,
  };
}

const SELECT = `SELECT n.*, COALESCE(i.thumb, i.poster, g.poster, p.poster) img FROM notifications n
  LEFT JOIN items i ON i.id = n.item_id LEFT JOIN items g ON g.id = i.grandparent_id LEFT JOIN items p ON p.id = i.parent_id`;

export const unreadCount = (userId: string) => db.get<{ n: number }>('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId)!.n;

export function listNotifications(user: User, limit = 50, unreadOnly = false): NotificationsResponse {
  const rows = db.all(`${SELECT} WHERE n.user_id = ? ${unreadOnly ? 'AND n.read_at IS NULL' : ''} ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?`, user.id, toInt(limit, 50, 1, 200));
  return { items: rows.map(toNotification), unread: unreadCount(user.id) };
}

/** Mark some (or, with no ids, all) of the viewer's notifications read. */
export function markRead(user: User, ids?: string[] | null): { unread: number } {
  const now = nowIso();
  if (ids?.length) {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400).map(String);
      db.run(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${chunk.map(() => '?').join(',')})`, now, user.id, ...chunk);
    }
  } else db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now, user.id);
  return { unread: unreadCount(user.id) };
}

export function notify(userId: string, n: { kind: NotificationKind; itemId: string | null; title: string; body?: string | null }): AppNotification {
  const id = newId();
  db.insert('notifications', { id, user_id: userId, kind: n.kind, item_id: n.itemId, title: n.title, body: n.body ?? null, created_at: nowIso(), read_at: null });
  db.run(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${KEEP})`, userId, userId);
  const notification = toNotification(db.get(`${SELECT} WHERE n.id = ?`, id)!);
  events.toUser(userId, { type: 'notification', notification, unread: unreadCount(userId) });
  return notification;
}

const code = (s: number | null, e: number | null) => (s != null && e != null ? `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}` : e != null ? `Episode ${e}` : '');

/** Who should hear about new episodes of `showId`: viewers who watched/started it or put it on My List. */
export function showFollowers(showId: string): string[] {
  return db.all<{ uid: string }>(
    `SELECT DISTINCT ud.user_id uid FROM items e JOIN user_data ud ON ud.item_id = e.id
     WHERE e.grandparent_id = ? AND e.type = 'episode' AND (ud.played = 1 OR ud.position_ms > 0)
     UNION SELECT user_id uid FROM watchlist WHERE item_id = ?`, showId, showId).map((r) => r.uid);
}

/** Create notifications for newly added episodes (called after a library scan). Returns how many were sent. */
export function notifyNewEpisodes(itemIds: string[]): number {
  if (!itemIds.length) return 0;
  const eps: Row[] = [];
  for (let i = 0; i < itemIds.length; i += 400) {
    const chunk = itemIds.slice(i, i + 400);
    eps.push(...db.all(`SELECT id, title, idx, parent_idx, grandparent_id FROM items WHERE type = 'episode' AND grandparent_id IS NOT NULL AND id IN (${chunk.map(() => '?').join(',')})`, ...chunk));
  }
  const byShow = new Map<string, Row[]>();
  for (const e of eps) {
    if (!byShow.has(e.grandparent_id)) byShow.set(e.grandparent_id, []);
    byShow.get(e.grandparent_id)!.push(e);
  }
  let sent = 0;
  for (const [showId, list] of byShow) {
    const show = db.get<{ title: string }>('SELECT title FROM items WHERE id = ?', showId);
    if (!show) continue;
    list.sort((a, b) => (a.parent_idx ?? 0) - (b.parent_idx ?? 0) || (a.idx ?? 0) - (b.idx ?? 0));
    const first = list[0];
    for (const uid of showFollowers(showId)) {
      let user: User;
      try {
        user = getUser(uid);
      } catch {
        continue;
      }
      if (user.disabled) continue;
      // Respect library access and parental limits for the episodes themselves.
      const a = accessClause(user);
      const visible = list.filter((e) => db.get(`SELECT 1 FROM items i WHERE i.id = ? AND ${a.sql}`, e.id, ...a.params));
      if (!visible.length) continue;
      const v0 = visible[0];
      notify(uid, visible.length === 1
        ? { kind: 'new-episode', itemId: v0.id, title: `New episode of ${show.title}`, body: [code(v0.parent_idx, v0.idx), v0.title].filter(Boolean).join(' · ') }
        : { kind: 'new-episode', itemId: v0.id, title: `${visible.length} new episodes of ${show.title}`, body: `From ${code(v0.parent_idx, v0.idx) || first.title}` });
      sent++;
    }
  }
  if (sent) log.info(`Sent ${sent} new-episode notification(s)`);
  return sent;
}

bus.on('library.new', ({ itemIds }: { itemIds: string[] }) => {
  try {
    notifyNewEpisodes(itemIds);
  } catch (e) {
    log.warn('New-episode notifications failed', (e as Error).message);
  }
});
