/**
 * Phone ↔ TV pairing by QR code.
 *
 * The TV (any signed-in device, normally the web app in TV mode) asks for a short-lived pairing code; the QR code
 * carries a long one-time secret, the screen also shows a 6-character code to type. A phone that is signed in claims
 * it:
 *  - same user → paired at once (it could already control that TV through "Play on…", so nothing new is exposed);
 *  - another user → the TV shows an accept / decline prompt; only after acceptance is a limited pairing created
 *    (transport control and browsing what the TV's user may watch — never their account, settings or history).
 *
 * Pairings are stored per device row (a sign-out deletes the device row and, by cascade, its pairings), expire
 * (cross-user after a few hours) and can be revoked by either side. Pending codes and requests live in memory only.
 * `remote.key` (D-pad / text) is routed only along an active pairing — even for your own devices.
 */
import crypto from 'node:crypto';
import type { Pairing, PairClaimResponse, PairedTarget, PairRequest, PairStartResponse, Platform, RemoteAction, RemotePlayerState, RemoteTrack, User } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { HttpError, badRequest, forbidden, notFound } from '../util/errors.js';
import { newId, newToken, sha256 } from '../util/ids.js';
import { nowIso } from '../util/misc.js';
import { getUser, qualifiedName, type AuthContext } from './auth.js';
import { events, type WsClient } from './events.js';
import { assertCanSee } from './items.js';

/** Tunables (tests shorten them). */
export const PAIR_LIMITS = {
  codeTtlMs: 5 * 60_000,
  requestTtlMs: 2 * 60_000,
  sameUserTtlMs: 90 * 86400_000,
  crossUserTtlMs: 12 * 3600_000,
  /** New codes per TV device per window. */
  startsPerWindow: 12,
  /** Failed claims per user / per client address per window. */
  failedClaimsPerWindow: 10,
  /** Pending cross-user requests per TV at once (stops prompt spam). */
  requestsPerTv: 3,
  windowMs: 10 * 60_000,
  totalPending: 2000,
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function pairCode(): string {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

interface PendingCode {
  code: string;
  tokenHash: string;
  tvUserId: string;
  tvDeviceRowId: string;
  tvDeviceName: string;
  expiresAt: number;
}
interface PendingRequest {
  id: string;
  tvUserId: string;
  tvDeviceRowId: string;
  tvDeviceName: string;
  ctlUserId: string;
  ctlUserName: string;
  ctlDeviceRowId: string;
  ctlDeviceName: string;
  expiresAt: number;
  status: 'pending' | 'paired' | 'declined' | 'expired';
  pairingId: string | null;
}

const codes = new Map<string, PendingCode>(); // by token hash
const requests = new Map<string, PendingRequest>();
const hits = new Map<string, number[]>();

function sweep() {
  const now = Date.now();
  for (const [k, c] of codes) if (c.expiresAt < now) codes.delete(k);
  for (const [k, r] of requests) {
    if (r.status === 'pending' && r.expiresAt < now) r.status = 'expired';
    if (r.expiresAt < now - 10 * 60_000) requests.delete(k);
  }
}

/** Sliding-window counter: true when `key` is already at `limit` within the window. */
function limited(key: string, limit: number): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => t > now - PAIR_LIMITS.windowMs);
  hits.set(key, list);
  return list.length >= limit;
}
function hit(key: string) {
  const list = hits.get(key) ?? [];
  list.push(Date.now());
  hits.set(key, list);
  if (hits.size > 10_000) for (const k of [...hits.keys()].slice(0, 1000)) hits.delete(k);
}

const rateLimited = (m: string) => new HttpError(429, m, 'rate_limited');

function assertDeviceSession(ctx: AuthContext) {
  if (ctx.deviceRowId.startsWith('apikey:')) throw forbidden('Pairing needs a signed-in device, not an API key');
}

/* ------------------------------- TV side ------------------------------- */

export function startPairing(ctx: AuthContext): PairStartResponse {
  assertDeviceSession(ctx);
  sweep();
  if (limited(`start:${ctx.deviceRowId}`, PAIR_LIMITS.startsPerWindow)) throw rateLimited('Too many pairing codes. Wait a few minutes and try again.');
  if (codes.size >= PAIR_LIMITS.totalPending) throw rateLimited('Too many devices are pairing right now. Try again in a minute.');
  hit(`start:${ctx.deviceRowId}`);
  // A new code on screen replaces this TV's earlier one.
  for (const [k, c] of codes) if (c.tvDeviceRowId === ctx.deviceRowId) codes.delete(k);
  const used = new Set([...codes.values()].map((c) => c.code));
  let code = pairCode();
  while (used.has(code)) code = pairCode();
  const token = newToken();
  const pending: PendingCode = {
    code, tokenHash: sha256(token), tvUserId: ctx.user.id, tvDeviceRowId: ctx.deviceRowId, tvDeviceName: ctx.device.deviceName,
    expiresAt: Date.now() + PAIR_LIMITS.codeTtlMs,
  };
  codes.set(pending.tokenHash, pending);
  const q = new URLSearchParams({ c: code, t: token }).toString();
  return { code, token, expiresAt: new Date(pending.expiresAt).toISOString(), path: `/pair?${q}` };
}

/** Accept or decline another user's pairing request — only on the TV the request is for. */
export function respondToRequest(ctx: AuthContext, requestId: string, accept: boolean): { status: PendingRequest['status']; pairingId: string | null } {
  sweep();
  const r = requests.get(String(requestId ?? ''));
  if (!r || r.tvDeviceRowId !== ctx.deviceRowId || r.tvUserId !== ctx.user.id) throw notFound('That request has expired');
  if (r.status !== 'pending') return { status: r.status, pairingId: r.pairingId };
  if (accept) {
    r.pairingId = createPairing(r.tvUserId, r.tvDeviceRowId, r.ctlUserId, r.ctlDeviceRowId, true);
    r.status = 'paired';
  } else r.status = 'declined';
  notifyDevice(r.ctlDeviceRowId, { type: 'pair.updated', pairingId: r.pairingId, requestId: r.id, status: r.status });
  notifyDevice(r.tvDeviceRowId, { type: 'pair.updated', pairingId: r.pairingId, requestId: r.id, status: r.status });
  if (r.pairingId) announcePairedFor(r.ctlDeviceRowId);
  return { status: r.status, pairingId: r.pairingId };
}

/** Pending cross-user requests for this TV (e.g. after the TV reconnects). */
export function pendingRequestsFor(ctx: AuthContext): PairRequest[] {
  sweep();
  return [...requests.values()].filter((r) => r.status === 'pending' && r.tvDeviceRowId === ctx.deviceRowId).map(toPairRequest);
}

const toPairRequest = (r: PendingRequest): PairRequest => ({ id: r.id, fromUserName: r.ctlUserName, fromDeviceName: r.ctlDeviceName, expiresAt: new Date(r.expiresAt).toISOString() });

/* ----------------------------- phone side ------------------------------ */

export function claimPairing(ctx: AuthContext, body: { code?: string; token?: string }, ip?: string | null): PairClaimResponse {
  assertDeviceSession(ctx);
  sweep();
  const userKey = `claim:u:${ctx.user.id}`;
  const ipKey = ip ? `claim:ip:${ip}` : null;
  if (limited(userKey, PAIR_LIMITS.failedClaimsPerWindow) || (ipKey && limited(ipKey, PAIR_LIMITS.failedClaimsPerWindow * 3))) {
    throw rateLimited('Too many wrong codes. Wait a few minutes and try again.');
  }
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  let pending: PendingCode | undefined;
  if (token) pending = codes.get(sha256(token));
  else if (code.length === 6) pending = [...codes.values()].find((c) => c.code === code);
  if (!pending || pending.expiresAt < Date.now()) {
    hit(userKey);
    if (ipKey) hit(ipKey);
    throw notFound('That pairing code is invalid or has expired. Show a new one on the TV.');
  }
  if (pending.tvDeviceRowId === ctx.deviceRowId) throw badRequest('This is the TV itself — scan the code with your phone');
  const tvOnline = events.clients().some((c) => c.deviceRowId === pending!.tvDeviceRowId);
  const tvUser = getUser(pending.tvUserId);
  const base = { targetDeviceId: pending.tvDeviceRowId, targetName: pending.tvDeviceName, ownerName: qualifiedName(tvUser) };
  // One-time: the code / QR can't be reused by someone else looking at the screen afterwards.
  codes.delete(pending.tokenHash);

  if (ctx.user.id === pending.tvUserId) {
    const pairingId = createPairing(pending.tvUserId, pending.tvDeviceRowId, ctx.user.id, ctx.deviceRowId, false);
    notifyDevice(pending.tvDeviceRowId, { type: 'pair.updated', pairingId, status: 'paired' });
    announcePairedFor(ctx.deviceRowId);
    return { status: 'paired', pairingId, requestId: null, ...base, crossUser: false };
  }
  if (!tvOnline) throw new HttpError(409, 'The TV is not connected right now. Open the app on the TV and try again.', 'offline');
  const open = [...requests.values()].filter((r) => r.status === 'pending' && r.tvDeviceRowId === pending!.tvDeviceRowId);
  if (open.length >= PAIR_LIMITS.requestsPerTv) throw rateLimited('That TV already has requests waiting. Try again in a minute.');
  const req: PendingRequest = {
    id: newId(), tvUserId: pending.tvUserId, tvDeviceRowId: pending.tvDeviceRowId, tvDeviceName: pending.tvDeviceName,
    ctlUserId: ctx.user.id, ctlUserName: qualifiedName(ctx.user), ctlDeviceRowId: ctx.deviceRowId, ctlDeviceName: ctx.device.deviceName,
    expiresAt: Date.now() + PAIR_LIMITS.requestTtlMs, status: 'pending', pairingId: null,
  };
  requests.set(req.id, req);
  notifyDevice(req.tvDeviceRowId, { type: 'pair.request', request: toPairRequest(req) });
  return { status: 'pending', pairingId: null, requestId: req.id, ...base, crossUser: true };
}

/** The phone polls its own request (fallback when the socket is down). */
export function requestStatus(ctx: AuthContext, requestId: string): { status: PendingRequest['status']; pairingId: string | null } {
  sweep();
  const r = requests.get(String(requestId ?? ''));
  if (!r || r.ctlDeviceRowId !== ctx.deviceRowId) throw notFound('Request not found');
  return { status: r.status, pairingId: r.pairingId };
}

/* ------------------------------ pairings ------------------------------- */

function createPairing(tvUserId: string, tvDeviceRowId: string, ctlUserId: string, ctlDeviceRowId: string, crossUser: boolean): string {
  const now = Date.now();
  // One active pairing per (TV, phone): pairing again renews it.
  db.run('UPDATE remote_pairings SET revoked_at = ? WHERE tv_device_id = ? AND ctl_device_id = ? AND revoked_at IS NULL', nowIso(), tvDeviceRowId, ctlDeviceRowId);
  const id = newId();
  db.insert('remote_pairings', {
    id, tv_user_id: tvUserId, tv_device_id: tvDeviceRowId, ctl_user_id: ctlUserId, ctl_device_id: ctlDeviceRowId, cross_user: crossUser ? 1 : 0,
    created_at: new Date(now).toISOString(), expires_at: new Date(now + (crossUser ? PAIR_LIMITS.crossUserTtlMs : PAIR_LIMITS.sameUserTtlMs)).toISOString(), revoked_at: null,
  });
  return id;
}

const ACTIVE = 'p.revoked_at IS NULL AND p.expires_at > ?';
const PAIR_SELECT = `SELECT p.*, td.device_name tv_name, td.platform tv_platform, td.user_id td_user, cd.device_name ctl_name, cd.user_id cd_user
  FROM remote_pairings p JOIN devices td ON td.id = p.tv_device_id JOIN devices cd ON cd.id = p.ctl_device_id`;

/** The active pairing from a controller device to a TV device, if any (device rows must still belong to the paired users). */
export function activePairing(ctlDeviceRowId: string, tvDeviceRowId: string): Row | null {
  if (!ctlDeviceRowId || !tvDeviceRowId) return null;
  const r = db.get(`${PAIR_SELECT} WHERE p.ctl_device_id = ? AND p.tv_device_id = ? AND ${ACTIVE} ORDER BY p.created_at DESC LIMIT 1`, ctlDeviceRowId, tvDeviceRowId, nowIso());
  if (!r || r.td_user !== r.tv_user_id || r.cd_user !== r.ctl_user_id) return null;
  return r;
}

const online = (deviceRowId: string) => events.clients().some((c) => c.deviceRowId === deviceRowId);
const stateOf = (deviceRowId: string) => {
  let st = null;
  for (const c of events.clients()) if (c.deviceRowId === deviceRowId && c.remoteState) st = c.remoteState;
  return st;
};
const nameOf = (userId: string) => {
  try {
    return qualifiedName(getUser(userId));
  } catch {
    return 'Someone';
  }
};

export function listPairings(ctx: AuthContext): Pairing[] {
  const rows = db.all(`${PAIR_SELECT} WHERE (p.tv_user_id = ? OR p.ctl_user_id = ?) AND ${ACTIVE} ORDER BY p.created_at DESC`, ctx.user.id, ctx.user.id, nowIso());
  return rows.map((r) => {
    const role: Pairing['role'] = r.tv_user_id === ctx.user.id && (r.tv_device_id === ctx.deviceRowId || r.ctl_user_id !== ctx.user.id) ? 'tv' : 'controller';
    return {
      id: r.id, role, tvDeviceId: r.tv_device_id, tvDeviceName: r.tv_name, controllerDeviceId: r.ctl_device_id, controllerDeviceName: r.ctl_name,
      otherUserName: nameOf(role === 'tv' ? r.ctl_user_id : r.tv_user_id), crossUser: !!r.cross_user, createdAt: r.created_at, expiresAt: r.expires_at,
      online: online(role === 'tv' ? r.ctl_device_id : r.tv_device_id),
    };
  });
}

/** Either side (either user) can end a pairing. */
export function revokePairing(ctx: AuthContext, id: string) {
  const r = db.get('SELECT * FROM remote_pairings WHERE id = ? AND revoked_at IS NULL', String(id ?? ''));
  if (!r || (r.tv_user_id !== ctx.user.id && r.ctl_user_id !== ctx.user.id)) throw notFound('Pairing not found');
  db.run('UPDATE remote_pairings SET revoked_at = ? WHERE id = ?', nowIso(), r.id);
  notifyDevice(r.tv_device_id, { type: 'pair.updated', pairingId: r.id, status: 'revoked' });
  notifyDevice(r.ctl_device_id, { type: 'pair.updated', pairingId: r.id, status: 'revoked' });
  announcePairedFor(r.ctl_device_id);
}

/** TVs this controller device is paired with. */
export function pairedTargets(ctlDeviceRowId: string): PairedTarget[] {
  const rows = db.all(`${PAIR_SELECT} WHERE p.ctl_device_id = ? AND ${ACTIVE} ORDER BY p.created_at DESC`, ctlDeviceRowId, nowIso());
  return rows.filter((r) => r.td_user === r.tv_user_id && r.cd_user === r.ctl_user_id).map((r) => ({
    pairingId: r.id, id: r.tv_device_id, deviceName: r.tv_name, platform: r.tv_platform as Platform, ownerName: nameOf(r.tv_user_id),
    crossUser: !!r.cross_user, online: online(r.tv_device_id), state: stateOf(r.tv_device_id),
  }));
}

function notifyDevice(deviceRowId: string, ev: Parameters<WsClient['send']>[0]) {
  events.broadcast(ev, (c) => c.deviceRowId === deviceRowId);
}

/** Push `pair.targets` to one controller device. */
export function announcePairedFor(ctlDeviceRowId: string) {
  if (!events.clients().some((c) => c.deviceRowId === ctlDeviceRowId)) return;
  notifyDevice(ctlDeviceRowId, { type: 'pair.targets', targets: pairedTargets(ctlDeviceRowId) });
}

/** A TV's state or presence changed: tell the phones paired with it. */
export function announceTv(tvDeviceRowId: string) {
  const rows = db.all<{ ctl_device_id: string }>('SELECT DISTINCT ctl_device_id FROM remote_pairings p WHERE p.tv_device_id = ? AND ' + ACTIVE, tvDeviceRowId, nowIso());
  for (const r of rows) announcePairedFor(r.ctl_device_id);
}

/* ------------------------------- routing ------------------------------- */

/** Transport and track actions a cross-user (guest) phone may send; plus playItem for titles the TV's user can see. */
const GUEST_ACTIONS = new Set<RemoteAction>(['play', 'pause', 'togglePause', 'stop', 'seek', 'next', 'previous', 'setVolume', 'setAudioTrack', 'setSubtitleTrack', 'skipSegment', 'playItem']);

/**
 * Which TV sockets a `remote.command` from `from` may reach: your own devices (as before), or a device you are
 * paired with — for another user's TV only guest actions, and playItem only for what that user may watch.
 */
export function commandTargets(from: WsClient, targetDeviceId: string, action: RemoteAction, itemId?: string): WsClient[] {
  const all = events.clients().filter((c) => c.deviceRowId === targetDeviceId && c !== from);
  if (!all.length) return [];
  if (all.every((c) => c.userId === from.userId)) return all;
  const p = activePairing(from.deviceRowId, targetDeviceId);
  if (!p || !p.cross_user) return [];
  if (!GUEST_ACTIONS.has(action)) return [];
  if (action === 'playItem') {
    if (!itemId) return [];
    try {
      assertCanSee(getUser(p.tv_user_id), itemId);
    } catch {
      return [];
    }
  }
  return all.filter((c) => c.userId === p.tv_user_id);
}

/** `remote.key` goes only along an active pairing (same-user or accepted cross-user), never to unpaired devices. */
export function keyTargets(from: WsClient, targetDeviceId: string): WsClient[] {
  const p = activePairing(from.deviceRowId, targetDeviceId);
  if (!p) return [];
  return events.clients().filter((c) => c.deviceRowId === targetDeviceId && c.userId === p.tv_user_id && c !== from);
}

/**
 * Who the phone acts as when it looks at a TV (second screen, browsing, song id): the TV's user. Allowed for your
 * own devices and for devices you are paired with; anything else is 403.
 */
export function tvContext(ctx: AuthContext, targetDeviceId: string): { tvUser: User; crossUser: boolean } {
  const dev = db.get<{ user_id: string }>('SELECT user_id FROM devices WHERE id = ?', String(targetDeviceId ?? ''));
  if (!dev) throw notFound('That TV is not signed in any more');
  if (dev.user_id === ctx.user.id) return { tvUser: ctx.user, crossUser: false };
  const p = activePairing(ctx.deviceRowId, targetDeviceId);
  if (!p) throw forbidden('This phone is not paired with that TV');
  return { tvUser: getUser(p.tv_user_id), crossUser: true };
}

/** The TV's live player state (from its socket), or null. */
export const tvState = stateOf;

export const REMOTE_KEYS = new Set<string>(['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'playPause', 'rewind', 'forward', 'info', 'text', 'backspace', 'submit']);

/** Sanitised second-screen extras of a reported player state (bounded lists, short strings). */
export function remoteStateExtras(s: Record<string, unknown>): Partial<RemotePlayerState> {
  const tracks = (v: unknown): RemoteTrack[] | undefined => Array.isArray(v)
    ? v.slice(0, 40).filter((t) => t && Number.isInteger(Number((t as RemoteTrack).index))).map((t) => ({ index: Number((t as RemoteTrack).index), label: String((t as RemoteTrack).label ?? '').slice(0, 80) }))
    : undefined;
  const idx = (v: unknown) => (v == null ? null : Number.isInteger(Number(v)) ? Number(v) : null);
  const out: Partial<RemotePlayerState> = {};
  if (s.audioTracks !== undefined) out.audioTracks = tracks(s.audioTracks);
  if (s.subtitleTracks !== undefined) out.subtitleTracks = tracks(s.subtitleTracks);
  if (s.audioIndex !== undefined) out.audioIndex = idx(s.audioIndex);
  if (s.subtitleIndex !== undefined) out.subtitleIndex = idx(s.subtitleIndex);
  if (s.skip !== undefined) {
    const k = s.skip as { type?: unknown; label?: unknown } | null;
    out.skip = k && typeof k === 'object' ? { type: String(k.type ?? '').slice(0, 20), label: String(k.label ?? '').slice(0, 40) } : null;
  }
  if (s.nextItemId !== undefined) out.nextItemId = typeof s.nextItemId === 'string' ? s.nextItemId.slice(0, 64) : null;
  return out;
}
