/**
 * Issues ("Report an issue", like Overseerr): viewers report video/audio/subtitle/other problems with a library item,
 * optionally a specific season/episode. Request managers see every issue, comment, resolve and reopen; reporters see
 * and comment on their own.
 */
import type { CreateIssueRequest, Issue, IssueComment, IssueKind, IssueStatus, User } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { newId } from '../util/ids.js';
import { badRequest, forbidden, notFound } from '../util/errors.js';
import { nowIso } from '../util/misc.js';
import { imageUrl } from './images.js';
import { assertCanSee } from './items.js';
import { bus } from './events.js';
import { logActivity } from './activity.js';
import { canManageRequests, effectivePermissions } from './requestPerms.js';
import { userRef } from './requests.js';

const KINDS: IssueKind[] = ['video', 'audio', 'subtitle', 'other'];

const SELECT = `SELECT s.*, (SELECT COUNT(*) FROM issue_comments c WHERE c.issue_id = s.id) comment_count FROM issues s`;

function toIssue(r: Row, withComments = false): Issue {
  return {
    id: r.id, kind: r.kind, status: r.status, itemId: r.item_id ?? null, rootItemId: r.root_item_id ?? null, mediaType: r.media_type, title: r.title,
    posterUrl: imageUrl(r.poster), season: r.season ?? null, episode: r.episode ?? null, message: r.message,
    createdBy: userRef(r.created_by), createdAt: r.created_at, updatedAt: r.updated_at, resolvedBy: userRef(r.resolved_by), resolvedAt: r.resolved_at ?? null,
    commentCount: r.comment_count ?? 0,
    ...(withComments ? { comments: comments(r.id) } : {}),
  };
}

const comments = (issueId: string): IssueComment[] =>
  db.all('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at, rowid', issueId).map((c) => ({ id: c.id, user: userRef(c.user_id), body: c.body, createdAt: c.created_at }));

function row(user: User, id: string): Row {
  const r = db.get(`${SELECT} WHERE s.id = ?`, id);
  if (!r || (r.created_by !== user.id && !canManageRequests(user))) throw notFound('Issue not found');
  return r;
}

export function listIssues(user: User, q: { status?: string; mine?: boolean; kind?: string } = {}): Issue[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!canManageRequests(user) || q.mine) where.push('s.created_by = ?'), params.push(user.id);
  if (q.status === 'open' || q.status === 'resolved') where.push('s.status = ?'), params.push(q.status);
  if (q.kind && KINDS.includes(q.kind as IssueKind)) where.push('s.kind = ?'), params.push(q.kind);
  return db.all(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE s.status WHEN 'open' THEN 0 ELSE 1 END, s.updated_at DESC LIMIT 500`, ...(params as any[])).map((r) => toIssue(r));
}

export const openIssueCount = (user: User) =>
  canManageRequests(user) ? db.get<{ n: number }>("SELECT COUNT(*) n FROM issues WHERE status = 'open'")!.n : db.get<{ n: number }>("SELECT COUNT(*) n FROM issues WHERE status = 'open' AND created_by = ?", user.id)!.n;

export const getIssue = (user: User, id: string) => toIssue(row(user, id), true);

export function createIssue(user: User, b: CreateIssueRequest): Issue {
  if (!effectivePermissions(user).reportIssues) throw forbidden("You don't have permission to report issues");
  if (!KINDS.includes(b?.kind)) throw badRequest('kind must be video, audio, subtitle or other');
  const message = String(b.message ?? '').trim().slice(0, 2000);
  if (!message) throw badRequest('Describe the problem');
  if (!b.itemId) throw badRequest('itemId is required');
  assertCanSee(user, b.itemId);
  const item = db.get('SELECT id, type, title, parent_id, grandparent_id, idx, parent_idx, poster, thumb FROM items WHERE id = ?', b.itemId);
  if (!item) throw notFound('Item not found');
  // Episodes/seasons/tracks: report against the show/album, keeping season/episode numbers.
  let root = item;
  if (item.type === 'episode' && item.grandparent_id) root = db.get('SELECT id, type, title, poster FROM items WHERE id = ?', item.grandparent_id) ?? item;
  else if ((item.type === 'season' || item.type === 'track') && item.parent_id) root = db.get('SELECT id, type, title, poster, parent_id FROM items WHERE id = ?', item.parent_id) ?? item;
  const num = (v: unknown) => (v == null || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const season = item.type === 'episode' ? item.parent_idx ?? null : item.type === 'season' ? item.idx ?? null : num(b.season);
  const episode = item.type === 'episode' ? item.idx ?? null : num(b.episode);
  const id = newId();
  const now = nowIso();
  db.insert('issues', {
    id, item_id: item.id, root_item_id: root.id, media_type: root.type, title: root.title, poster: root.poster ?? item.poster ?? item.thumb ?? null, kind: b.kind,
    status: 'open', season, episode, message, created_by: user.id, created_at: now, updated_at: now,
  });
  logActivity('issue.create', `${user.displayName} reported a ${b.kind} issue with ${root.title}`, { userId: user.id, userName: user.displayName });
  const issue = getIssue(user, id);
  bus.emit('issue.created', { issue, user });
  return issue;
}

export function commentIssue(user: User, id: string, body: string): Issue {
  row(user, id);
  const text = String(body ?? '').trim().slice(0, 2000);
  if (!text) throw badRequest('Write a comment');
  db.insert('issue_comments', { id: newId(), issue_id: id, user_id: user.id, body: text, created_at: nowIso() });
  db.run('UPDATE issues SET updated_at = ? WHERE id = ?', nowIso(), id);
  const issue = getIssue(user, id);
  bus.emit('issue.comment', { issue, user, body: text });
  return issue;
}

export function setIssueStatus(user: User, id: string, status: IssueStatus): Issue {
  const r = row(user, id);
  // Reporters may resolve their own issue (e.g. it fixed itself); only managers reopen others' or resolve any.
  if (!canManageRequests(user) && r.created_by !== user.id) throw forbidden();
  if (r.status === status) return getIssue(user, id);
  const now = nowIso();
  if (status === 'resolved') db.run("UPDATE issues SET status = 'resolved', resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?", user.id, now, now, id);
  else db.run("UPDATE issues SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?", now, id);
  const issue = getIssue(user, id);
  bus.emit(status === 'resolved' ? 'issue.resolved' : 'issue.reopened', { issue, user });
  return issue;
}

export function deleteIssue(user: User, id: string) {
  const r = row(user, id);
  if (!canManageRequests(user) && (r.created_by !== user.id || r.comment_count > 0)) throw forbidden('Only request managers can delete issues with comments');
  db.run('DELETE FROM issues WHERE id = ?', id);
}
