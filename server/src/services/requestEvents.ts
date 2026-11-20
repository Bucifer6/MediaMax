/**
 * Request & issue lifecycle notifications: in-app notifications (bell), notification agents (Discord, Telegram, email…)
 * and the existing JSON webhooks (dispatched in webhooks.ts).
 *
 * new request → managers · approved / declined (with reason) / available → requester · failed → managers ·
 * comments → the other side · issues: new → managers, comment/resolved/reopened → reporter (or managers).
 */
import type { Issue, MediaRequest, NotifyEvent, User } from '@mediamax/shared';
import { bus } from './events.js';
import { notify } from './notifications.js';
import { requestManagers } from './requestPerms.js';
import { dispatch, publicLink, type NotifyMessage } from './notify/agents.js';
import { logger } from '../util/log.js';

const log = logger('request-events');

const TYPE: Record<string, string> = { movie: 'Movie', show: 'Show', artist: 'Artist', album: 'Album', book: 'Book' };
const label = (r: MediaRequest) => `${r.title}${r.year ? ` (${r.year})` : ''}`;
const reqLink = (r: MediaRequest) => `/requests?id=${encodeURIComponent(r.id)}`;
const issueLink = (i: Issue) => `/issues/${encodeURIComponent(i.id)}`;
const seasonsText = (r: MediaRequest) => (r.mediaType !== 'show' ? null : r.seasonMode === 'specific' ? `Season${r.seasons.length > 1 ? 's' : ''} ${r.seasons.join(', ')}` : r.seasonMode === 'all' ? 'All seasons' : `${r.seasonMode[0].toUpperCase()}${r.seasonMode.slice(1)} season`);

function reqFields(r: MediaRequest): { name: string; value: string }[] {
  return [
    { name: 'Requested by', value: r.requestedBy.displayName },
    { name: 'Type', value: `${TYPE[r.mediaType] ?? r.mediaType}${r.also4k ? ' (+4K)' : ''}` },
    ...(seasonsText(r) ? [{ name: 'Seasons', value: seasonsText(r)! }] : []),
    { name: 'Status', value: r.status },
  ];
}

function send(m: Omit<NotifyMessage, 'url'> & { path: string }) {
  void dispatch({ ...m, url: publicLink(m.path) }).catch(() => undefined);
}

const toMany = (ids: string[], except: string | null, n: Parameters<typeof notify>[1]) => {
  for (const uid of new Set(ids)) if (uid !== except) notify(uid, n);
};

function safe<T>(fn: (x: T) => void) {
  return (x: T) => {
    try {
      fn(x);
    } catch (e) {
      log.warn('Notification failed', (e as Error).message);
    }
  };
}

let started = false;
export function initRequestNotifications() {
  if (started) return;
  started = true;

  bus.on('request.created', safe((r: MediaRequest & { autoApproved?: boolean }) => {
    const auto = !!r.autoApproved;
    const title = auto ? `${r.requestedBy.displayName} requested ${label(r)} (auto-approved)` : `New request: ${label(r)}`;
    const body = auto ? `${TYPE[r.mediaType] ?? 'Title'} approved automatically` : `${r.requestedBy.displayName} requested a ${(TYPE[r.mediaType] ?? 'title').toLowerCase()}${r.also4k ? ' (+4K)' : ''}${r.note ? ` — “${r.note}”` : ''}`;
    toMany(requestManagers(), r.requestedBy.id, { kind: 'request', itemId: null, title, body, link: reqLink(r) });
    send({ event: auto ? 'request.auto_approved' : 'request.pending', title, body: r.note ? `Note: ${r.note}` : body, imageUrl: null, fields: reqFields(r), path: reqLink(r), data: { request: r } });
  }));

  bus.on('request.approved', safe(({ request: r, actor, auto }: { request: MediaRequest; actor: User; auto: boolean }) => {
    if (auto) return;
    if (actor.id !== r.requestedBy.id) notify(r.requestedBy.id, { kind: 'request', itemId: null, title: `Request approved: ${label(r)}`, body: `Approved by ${actor.displayName}${r.status === 'processing' ? ' and sent for download' : ''}`, link: reqLink(r) });
    send({ event: 'request.approved', title: `Request approved: ${label(r)}`, body: `Approved by ${actor.displayName}`, fields: reqFields(r), path: reqLink(r), data: { request: r } });
  }));

  bus.on('request.declined', safe(({ request: r, actor, reason }: { request: MediaRequest; actor: User; reason: string | null }) => {
    if (actor.id !== r.requestedBy.id) notify(r.requestedBy.id, { kind: 'request', itemId: null, title: `Request declined: ${label(r)}`, body: reason ? `Reason: ${reason}` : `Declined by ${actor.displayName}`, link: reqLink(r) });
    send({ event: 'request.declined', title: `Request declined: ${label(r)}`, body: reason ? `Reason: ${reason}` : `Declined by ${actor.displayName}`, fields: reqFields(r), path: reqLink(r), data: { request: r, reason } });
  }));

  bus.on('request.available', safe((r: MediaRequest) => {
    notify(r.requestedBy.id, { kind: 'request', itemId: r.itemId, title: `${label(r)} is now available`, body: 'Your request is ready to watch', link: r.itemId ? `/item/${r.itemId}` : reqLink(r) });
    send({ event: 'request.available', title: `Now available: ${label(r)}`, body: `Requested by ${r.requestedBy.displayName}`, fields: reqFields(r), path: r.itemId ? `/item/${r.itemId}` : reqLink(r), data: { request: r } });
  }));

  bus.on('request.failed', safe(({ request: r }: { request: MediaRequest }) => {
    toMany(requestManagers(), null, { kind: 'request', itemId: null, title: `Request failed: ${label(r)}`, body: r.error ?? 'Sending to the download manager failed', link: reqLink(r) });
    send({ event: 'request.failed', title: `Request failed: ${label(r)}`, body: r.error ?? 'Sending to the download manager failed', fields: reqFields(r), path: reqLink(r), data: { request: r } });
  }));

  bus.on('request.comment', safe(({ request: r, user, body }: { request: MediaRequest; user: User; body: string }) => {
    const n = { kind: 'request' as const, itemId: null, title: `${user.displayName} commented on ${label(r)}`, body: body.slice(0, 200), link: reqLink(r) };
    if (user.id === r.requestedBy.id) toMany(requestManagers(), user.id, n);
    else notify(r.requestedBy.id, n);
    send({ event: 'request.comment', title: n.title, body, fields: reqFields(r), path: reqLink(r), data: { request: r } });
  }));

  const issueFields = (i: Issue) => [
    { name: 'Problem', value: i.kind },
    ...(i.season != null ? [{ name: 'Episode', value: i.episode != null ? `S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}` : `Season ${i.season}` }] : []),
    { name: 'Reported by', value: i.createdBy?.displayName ?? 'Unknown' },
  ];
  const issueEvent = (ev: NotifyEvent, i: Issue, title: string, body: string) => send({ event: ev, title, body, fields: issueFields(i), path: issueLink(i), data: { issue: i } });

  bus.on('issue.created', safe(({ issue: i, user }: { issue: Issue; user: User }) => {
    const title = `New ${i.kind} issue: ${i.title}`;
    toMany(requestManagers(), user.id, { kind: 'issue', itemId: i.itemId, title, body: i.message.slice(0, 200), link: issueLink(i) });
    issueEvent('issue.created', i, title, i.message);
  }));
  bus.on('issue.comment', safe(({ issue: i, user, body }: { issue: Issue; user: User; body: string }) => {
    const n = { kind: 'issue' as const, itemId: i.itemId, title: `${user.displayName} replied on ${i.title}`, body: body.slice(0, 200), link: issueLink(i) };
    if (i.createdBy && user.id !== i.createdBy.id) notify(i.createdBy.id, n);
    else toMany(requestManagers(), user.id, n);
    issueEvent('issue.comment', i, n.title, body);
  }));
  for (const [ev, word] of [['issue.resolved', 'resolved'], ['issue.reopened', 'reopened']] as const) {
    bus.on(ev, safe(({ issue: i, user }: { issue: Issue; user: User }) => {
      const title = `Issue ${word}: ${i.title}`;
      if (i.createdBy && user.id !== i.createdBy.id) notify(i.createdBy.id, { kind: 'issue', itemId: i.itemId, title, body: `${word[0].toUpperCase()}${word.slice(1)} by ${user.displayName}`, link: issueLink(i) });
      issueEvent(ev, i, title, `${word[0].toUpperCase()}${word.slice(1)} by ${user.displayName}`);
    }));
  }
}
