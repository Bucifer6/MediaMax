/**
 * Phone ↔ TV pairing (QR), the phone remote's helpers, the second screen and "What's this song?".
 * Every route needs a signed-in user; nothing here is reachable without authentication.
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Item, PairClaimRequest, SecondScreenInfo } from '@mediamax/shared';
import { db } from '../db.js';
import { remoteAddr, requireUser } from '../http.js';
import { badRequest, notFound } from '../util/errors.js';
import { toInt } from '../util/misc.js';
import { assertCanSee, getChildren, getItem, nextItem, queryItems, continueWatching, searchItems } from '../services/items.js';
import * as pairing from '../services/pairing.js';
import { identifyAt, identifyClip } from '../services/songid.js';
import { sheetPath, trickplayInfo } from '../services/trickplay.js';

const NEUTRAL_USERDATA: Item['userData'] = { played: false, playCount: 0, positionMs: 0, favorite: false, lastPlayedAt: null, rating: null, inWatchlist: false, notInterested: false };

/** A guest (another user's phone) sees titles, never the TV user's history, ratings or file details. */
function forGuest(item: Item): Item {
  const { media: _m, lockedFields: _l, smart: _s, ...rest } = item;
  return { ...rest, userData: NEUTRAL_USERDATA };
}
const shape = (items: Item[], guest: boolean) => (guest ? items.map(forGuest) : items);

export default async function pairRoutes(app: FastifyInstance) {
  /* ------------------------------ pairing ------------------------------ */
  app.post('/pair/start', async (req) => pairing.startPairing(requireUser(req)));
  app.post<{ Body: PairClaimRequest }>('/pair/claim', async (req) => pairing.claimPairing(requireUser(req), req.body ?? {}, remoteAddr(req)));
  app.get('/pair/requests', async (req) => pairing.pendingRequestsFor(requireUser(req)));
  app.get<{ Params: { id: string } }>('/pair/requests/:id', async (req) => pairing.requestStatus(requireUser(req), req.params.id));
  app.post<{ Params: { id: string }; Body: { accept?: boolean } }>('/pair/requests/:id', async (req) =>
    pairing.respondToRequest(requireUser(req), req.params.id, req.body?.accept === true));
  app.get('/pair/pairings', async (req) => pairing.listPairings(requireUser(req)));
  app.delete<{ Params: { id: string } }>('/pair/pairings/:id', async (req) => {
    pairing.revokePairing(requireUser(req), req.params.id);
    return { ok: true };
  });
  app.get('/pair/targets', async (req) => pairing.pairedTargets(requireUser(req).deviceRowId));

  /* ---------------------------- second screen --------------------------- */
  app.get<{ Params: { deviceId: string } }>('/pair/targets/:deviceId/now', async (req): Promise<SecondScreenInfo> => {
    const a = requireUser(req);
    const { tvUser, crossUser } = pairing.tvContext(a, req.params.deviceId);
    const st = pairing.tvState(req.params.deviceId);
    if (!st?.itemId) throw notFound('Nothing is playing on that TV');
    const item = getItem(tvUser, st.itemId, true);
    const mediaId = item.media?.[0]?.id ?? null;
    const tp = mediaId ? trickplayInfo(mediaId, a.token) : null;
    // Thumbnails go through the pairing route, so a guest needs no access of their own.
    const trickplay = tp ? { ...tp, sheets: tp.sheets.map((_, i) => `/api/v1/pair/targets/${encodeURIComponent(req.params.deviceId)}/trickplay/${encodeURIComponent(tp.mediaId)}/${i}.jpg?token=${encodeURIComponent(a.token)}`) } : null;
    let show: Item | null = null;
    let episodes: Item[] = [];
    if (item.type === 'episode') {
      if (item.grandparentId) show = safe(() => getItem(tvUser, item.grandparentId!, false));
      if (item.parentId) episodes = safe(() => getChildren(tvUser, item.parentId!, { limit: 200 }).items) ?? [];
    }
    const next = safe(() => nextItem(tvUser, item.id));
    return {
      item: crossUser ? forGuest(item) : item, show: show && crossUser ? forGuest(show) : show,
      episodes: shape(episodes, crossUser), next: next && crossUser ? forGuest(next) : next, trickplay,
    };
  });

  app.get<{ Params: { deviceId: string; mediaId: string; file: string } }>('/pair/targets/:deviceId/trickplay/:mediaId/:file', async (req, reply) => {
    const a = requireUser(req);
    const { tvUser } = pairing.tvContext(a, req.params.deviceId);
    const m = db.get<{ item_id: string }>('SELECT item_id FROM media WHERE id = ?', req.params.mediaId);
    if (!m) throw notFound();
    assertCanSee(tvUser, m.item_id);
    const p = sheetPath(req.params.mediaId, parseInt(req.params.file, 10));
    if (!p) throw notFound();
    reply.type('image/jpeg').header('Cache-Control', 'private, max-age=604800');
    return fs.createReadStream(p);
  });

  /** Browse what the TV's user may watch ("Play on TV" from the phone). Guests never see the TV user's history. */
  app.get<{ Params: { deviceId: string }; Querystring: { q?: string; parentId?: string } }>('/pair/targets/:deviceId/browse', async (req) => {
    const a = requireUser(req);
    const { tvUser, crossUser } = pairing.tvContext(a, req.params.deviceId);
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    if (req.query.parentId) return { items: shape(getChildren(tvUser, req.query.parentId, { limit: 300 }).items, crossUser) };
    if (q) return { items: shape(searchItems(tvUser, q, 40).filter(playable), crossUser) };
    const recent = queryItems(tvUser, { type: 'movie,show', sort: 'addedAt', order: 'desc', limit: 30 }).items;
    const resume = crossUser ? [] : continueWatching(tvUser, 12);
    return { continueWatching: resume, items: shape(recent, crossUser) };
  });

  /* ------------------------------ song id ------------------------------ */
  /** Identify the music at the TV's current position (server-side, from the file). */
  app.post<{ Params: { deviceId: string }; Body: { positionMs?: number } }>('/pair/targets/:deviceId/identify-song', async (req) => {
    const a = requireUser(req);
    const { tvUser } = pairing.tvContext(a, req.params.deviceId);
    const st = pairing.tvState(req.params.deviceId);
    if (!st?.itemId) throw notFound('Nothing is playing on that TV');
    const pos = req.body?.positionMs != null ? toInt(req.body.positionMs, 0, 0) : st.positionMs;
    return identifyAt(tvUser, a.user, st.itemId, pos, st.audioIndex ?? null);
  });
  /** Identify the music in one of your own titles at a position (web player / own devices). */
  app.post<{ Params: { id: string }; Body: { positionMs?: number; audioIndex?: number | null } }>('/songid/items/:id', async (req) => {
    const a = requireUser(req);
    return identifyAt(a.user, a.user, req.params.id, toInt(req.body?.positionMs, 0, 0), req.body?.audioIndex ?? null);
  });
  /** Microphone fallback: a short recording (multipart field `file`). */
  app.post('/songid/clip', async (req) => {
    const a = requireUser(req);
    const file = await req.file();
    if (!file) throw badRequest('No recording received');
    return identifyClip(a.user, await file.toBuffer());
  });
}

const playable = (i: Item) => ['movie', 'show', 'episode', 'video', 'season'].includes(i.type);

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

