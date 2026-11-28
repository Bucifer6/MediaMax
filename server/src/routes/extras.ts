import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { requireAdmin, requireUser } from '../http.js';
import { assertCanSee, getItem, queryItems } from '../services/items.js';
import { sheetPath, trickplayInfo } from '../services/trickplay.js';
import { serverStats, userStats } from '../services/stats.js';
import { deleteDownloadedSubtitle, downloadSubtitle, providerInfos, searchSubtitles } from '../services/subtitleProviders/index.js';
import { subtitleTools } from '../services/subtitleProviders/tools.js';
import { disconnect, setScrobble, startDeviceAuth, traktStatus } from '../services/trakt.js';
import { notFound, badRequest, forbidden } from '../util/errors.js';
import { toInt } from '../util/misc.js';
import { newId } from '../util/ids.js';
import { events } from '../services/events.js';
import { getLyrics } from '../services/lyrics.js';
import * as podcasts from '../services/podcasts.js';
import * as lastfm from '../services/lastfm.js';
import * as requests from '../services/requests.js';
import * as smart from '../services/smart.js';
import { createContainer } from '../services/items.js';
import { getSettings } from '../services/settings.js';
import type { CreateSmartListRequest, SmartFilter } from '@mediamax/shared';
import type { AutoSyncRequest, SubmitMarkerRequest, SubscribePodcastRequest } from '@mediamax/shared';
import { autoSync } from '../services/autosync.js';
import { parentalGuide, submitMarker } from '../services/skipSegments.js';

export default async function extraRoutes(app: FastifyInstance) {
  /* ------------------------------ trickplay ------------------------- */
  app.get<{ Params: { id: string }; Querystring: { mediaId?: string } }>('/items/:id/trickplay', async (req) => {
    const a = requireUser(req);
    assertCanSee(a.user, req.params.id);
    const m = req.query.mediaId
      ? db.get('SELECT id FROM media WHERE id = ? AND item_id = ?', req.query.mediaId, req.params.id)
      : db.get('SELECT id FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', req.params.id);
    const info = m ? trickplayInfo(m.id, a.token) : null;
    if (!info) throw notFound('No preview thumbnails for this item yet');
    return info;
  });
  app.get<{ Params: { mediaId: string; file: string } }>('/trickplay/:mediaId/:file', async (req, reply) => {
    const { user } = requireUser(req);
    const m = db.get('SELECT item_id FROM media WHERE id = ?', req.params.mediaId);
    if (!m) throw notFound();
    assertCanSee(user, m.item_id);
    const p = sheetPath(req.params.mediaId, parseInt(req.params.file, 10));
    if (!p) throw notFound();
    reply.type('image/jpeg').header('Cache-Control', 'private, max-age=604800');
    return fs.createReadStream(p);
  });

  /* ------------------------------- requests ------------------------- */
  // Discover / requests / issues routes live in routes/requests.ts.
  app.post<{ Body: { url: string; apiKey: string } }>('/requests/arr/test', async (req) => {
    requireAdmin(req);
    if (!req.body?.url || !req.body?.apiKey) throw badRequest('url and apiKey are required');
    return requests.arrOptions(req.body);
  });

  /* ------------------------------ smart lists ----------------------- */
  app.post<{ Body: { filter: SmartFilter; limit?: number } }>('/smart/preview', async (req) => {
    const { user } = requireUser(req);
    return smart.evaluateSmart(user, smart.normaliseFilter(req.body?.filter), toInt(req.body?.limit, 50, 1, 200), 0);
  });
  app.post<{ Body: CreateSmartListRequest }>('/smart', async (req) => {
    const { user } = requireUser(req);
    const b = req.body ?? ({} as CreateSmartListRequest);
    if (b.kind === 'collection' && !user.isAdmin) throw forbidden('Only administrators can create smart collections');
    if (b.kind !== 'collection' && b.kind !== 'playlist') throw badRequest('kind must be collection or playlist');
    if (!b.title?.trim()) throw badRequest('Title required');
    const filter = smart.normaliseFilter(b.filter);
    smart.evaluateSmart(user, filter, 1, 0); // validate rules
    const id = createContainer(b.kind, b.title.trim().slice(0, 200), b.kind === 'playlist' ? user.id : null, [], b.overview);
    db.run('UPDATE items SET smart = ? WHERE id = ?', JSON.stringify(filter), id);
    // Artwork: borrow the first match's poster/backdrop.
    const first = smart.evaluateSmart(user, filter, 1, 0).items[0];
    if (first) db.run('UPDATE items SET poster = (SELECT COALESCE(poster, (SELECT poster FROM items g WHERE g.id = x.grandparent_id)) FROM items x WHERE x.id = ?), backdrop = (SELECT backdrop FROM items WHERE id = ?) WHERE id = ?', first.id, first.id, id);
    return getItem(user, id, false);
  });
  app.put<{ Params: { id: string }; Body: { title?: string; overview?: string; filter?: SmartFilter } }>('/smart/:id', async (req) => {
    const { user } = requireUser(req);
    const row = db.get('SELECT * FROM items WHERE id = ? AND smart IS NOT NULL', req.params.id);
    if (!row) throw notFound('Smart list not found');
    if (row.type === 'collection' ? !user.isAdmin : row.owner_id !== user.id && !user.isAdmin) throw forbidden();
    if (req.body?.title?.trim()) db.run('UPDATE items SET title = ?, sort_title = ? WHERE id = ?', req.body.title.trim().slice(0, 200), req.body.title.trim().toLowerCase(), req.params.id);
    if (req.body?.overview !== undefined) db.run('UPDATE items SET overview = ? WHERE id = ?', req.body.overview, req.params.id);
    if (req.body?.filter) {
      const filter = smart.normaliseFilter(req.body.filter);
      smart.evaluateSmart(user, filter, 1, 0);
      db.run('UPDATE items SET smart = ? WHERE id = ?', JSON.stringify(filter), req.params.id);
    }
    return getItem(user, req.params.id, false);
  });

  /* -------------------------------- last.fm ------------------------- */
  app.get('/lastfm', async (req) => lastfm.pollAuth(requireUser(req).user.id));
  app.post('/lastfm/connect', async (req) => lastfm.startAuth(requireUser(req).user.id));
  app.patch<{ Body: { scrobble: boolean } }>('/lastfm', async (req) => {
    const { user } = requireUser(req);
    lastfm.setLastfmScrobble(user.id, !!req.body?.scrobble);
    return lastfm.lastfmStatus(user.id);
  });
  app.delete('/lastfm', async (req) => {
    const { user } = requireUser(req);
    lastfm.disconnectLastfm(user.id);
    return lastfm.lastfmStatus(user.id);
  });

  /* ------------------------------- podcasts ------------------------- */
  app.get('/podcasts', async (req) => {
    requireUser(req);
    return podcasts.listSubscriptions();
  });
  app.get<{ Querystring: { q?: string } }>('/podcasts/search', async (req) => {
    requireUser(req);
    return podcasts.searchDirectory(req.query.q ?? '');
  });
  app.post<{ Body: SubscribePodcastRequest }>('/podcasts', async (req) => {
    const { user } = requireUser(req);
    if (!req.body?.feedUrl) throw badRequest('feedUrl required');
    return podcasts.subscribe(user.id, req.body.feedUrl, !!req.body.autoDownload);
  });
  app.post<{ Body: { opml: string } }>('/podcasts/import', async (req) => {
    const { user } = requireUser(req);
    const urls = podcasts.parseOpml(req.body?.opml ?? '');
    if (!urls.length) throw badRequest('No podcast feeds found in that OPML file');
    const results = { added: 0, skipped: 0, failed: [] as string[] };
    for (const u of urls) {
      try {
        await podcasts.subscribe(user.id, u);
        results.added++;
      } catch (e) {
        if ((e as any).statusCode === 409) results.skipped++;
        else results.failed.push(u);
      }
    }
    return results;
  });
  const canManage = (userId: string, isAdmin: boolean, id: string) => {
    const r = db.get('SELECT created_by FROM podcast_feeds WHERE id = ?', id);
    if (!r) throw notFound('Subscription not found');
    if (!isAdmin && r.created_by !== userId) throw forbidden('Only the person who subscribed (or an admin) can change this podcast');
  };
  app.patch<{ Params: { id: string }; Body: { autoDownload?: boolean } }>('/podcasts/:id', async (req) => {
    const { user } = requireUser(req);
    canManage(user.id, user.isAdmin, req.params.id);
    return podcasts.updateSubscription(req.params.id, req.body ?? {});
  });
  app.post<{ Params: { id: string } }>('/podcasts/:id/refresh', async (req) => {
    const { user } = requireUser(req);
    canManage(user.id, user.isAdmin, req.params.id);
    return { newEpisodes: await podcasts.refreshFeed(req.params.id) };
  });
  app.delete<{ Params: { id: string } }>('/podcasts/:id', async (req) => {
    const { user } = requireUser(req);
    canManage(user.id, user.isAdmin, req.params.id);
    podcasts.unsubscribe(req.params.id);
    return { ok: true };
  });

  /* ----------------------------- remote control --------------------- */
  app.get('/remote/targets', async (req) => {
    const a = requireUser(req);
    return events.remoteTargets(a.user.id).filter((t) => t.id !== a.deviceRowId);
  });

  /* -------------------------------- extras -------------------------- */
  app.get<{ Params: { id: string } }>('/items/:id/extras', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    const order = ['trailer', 'featurette', 'behindthescenes', 'deleted', 'interview', 'scene', 'short', 'other'];
    return queryItems(user, { parentId: req.params.id, type: 'video', sort: 'title', limit: 200 }).items
      .sort((a, b) => order.indexOf(a.extraType ?? 'other') - order.indexOf(b.extraType ?? 'other'));
  });

  /* ------------------------------- cinema mode ---------------------- */
  // Trailers for other (unwatched) movies, then one pre-roll clip; empty unless enabled and the item is a movie.
  app.get<{ Params: { id: string } }>('/items/:id/intros', async (req) => {
    const { user } = requireUser(req);
    const row = assertCanSee(user, req.params.id);
    const cfg = getSettings().cinema;
    if (!cfg.enabled || row.type !== 'movie' || user.preferences?.cinemaMode === false) return [];
    const visible = (id: string) => {
      try {
        assertCanSee(user, id);
        return true;
      } catch {
        return false;
      }
    };
    const out: string[] = [];
    const want = Math.max(0, Math.min(5, cfg.trailers | 0));
    if (want) {
      const cands = db.all<{ id: string; movie: string }>(
        `SELECT x.id, m.id movie FROM items x JOIN items m ON m.id = x.parent_id
         WHERE x.type = 'video' AND json_extract(x.extra, '$.extraType') = 'trailer' AND m.type = 'movie' AND m.id != ?
         ${cfg.unwatchedOnly ? 'AND NOT EXISTS (SELECT 1 FROM user_data ud WHERE ud.item_id = m.id AND ud.user_id = ? AND ud.played = 1)' : 'AND ? IS NOT NULL'}
         ORDER BY random() LIMIT 40`, row.id, user.id);
      const movies = new Set<string>();
      for (const c of cands) {
        if (out.length >= want) break;
        if (movies.has(c.movie) || !visible(c.movie)) continue;
        movies.add(c.movie);
        out.push(c.id);
      }
    }
    if (cfg.prerollLibraryId) {
      const pre = db.all<{ id: string }>("SELECT id FROM items WHERE library_id = ? AND type IN ('video','movie') AND EXISTS (SELECT 1 FROM media WHERE item_id = items.id) ORDER BY random() LIMIT 10", cfg.prerollLibraryId)
        .find((p) => visible(p.id));
      if (pre) out.push(pre.id);
    }
    return out.map((id) => getItem(user, id, false));
  });

  /* ------------------------------- bookmarks ------------------------ */
  app.get<{ Params: { id: string } }>('/items/:id/bookmarks', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    return db.all('SELECT * FROM bookmarks WHERE user_id = ? AND item_id = ? ORDER BY position_ms', user.id, req.params.id)
      .map((b) => ({ id: b.id, itemId: b.item_id, positionMs: b.position_ms, note: b.note ?? null, createdAt: b.created_at }));
  });
  app.post<{ Params: { id: string }; Body: { positionMs: number; note?: string } }>('/items/:id/bookmarks', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    const pos = Math.max(0, Math.round(Number(req.body?.positionMs) || 0));
    if (db.get<{ n: number }>('SELECT COUNT(*) n FROM bookmarks WHERE user_id = ? AND item_id = ?', user.id, req.params.id)!.n >= 500) throw badRequest('Too many bookmarks');
    const b = { id: newId(), user_id: user.id, item_id: req.params.id, position_ms: pos, note: req.body?.note ? String(req.body.note).slice(0, 1000) : null, created_at: new Date().toISOString() };
    db.insert('bookmarks', b);
    return { id: b.id, itemId: b.item_id, positionMs: pos, note: b.note, createdAt: b.created_at };
  });
  app.delete<{ Params: { id: string; bookmarkId: string } }>('/items/:id/bookmarks/:bookmarkId', async (req) => {
    const { user } = requireUser(req);
    db.run('DELETE FROM bookmarks WHERE id = ? AND user_id = ?', req.params.bookmarkId, user.id);
    return { ok: true };
  });

  /* -------------------------------- lyrics -------------------------- */
  app.get<{ Params: { id: string } }>('/items/:id/lyrics', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    const l = await getLyrics(req.params.id, user.id);
    if (!l) throw notFound('No lyrics for this track');
    return { ...l, canEdit: user.isAdmin };
  });

  /* -------------------------------- stats --------------------------- */
  app.get<{ Querystring: { year?: string } }>('/stats/me', async (req) => {
    const { user } = requireUser(req);
    return userStats(user.id, req.query.year ? toInt(req.query.year, new Date().getFullYear(), 2000, 2100) : null);
  });
  app.get<{ Params: { id: string }; Querystring: { year?: string } }>('/stats/users/:id', async (req) => {
    requireAdmin(req);
    return userStats(req.params.id, req.query.year ? toInt(req.query.year, new Date().getFullYear(), 2000, 2100) : null);
  });
  app.get<{ Querystring: { days?: string } }>('/stats/server', async (req) => {
    requireAdmin(req);
    return serverStats(toInt(req.query.days, 30, 1, 366));
  });

  /* ------------------------------ subtitles ------------------------- */
  app.get<{ Params: { id: string }; Querystring: { languages?: string } }>('/items/:id/subtitles/search', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    const langs = (req.query.languages ?? user.preferences.subtitleLanguage ?? 'en').split(',').map((s) => s.trim()).filter(Boolean);
    return searchSubtitles(req.params.id, langs);
  });
  app.post<{ Params: { id: string }; Body: { fileId: string; language: string; provider?: string; hearingImpaired?: boolean; forced?: boolean; release?: string | null; score?: number | null } }>('/items/:id/subtitles/download', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    if (!req.body?.fileId) throw badRequest('fileId required');
    const b = req.body;
    await downloadSubtitle(req.params.id, {
      provider: typeof b.provider === 'string' ? b.provider : undefined, fileId: String(b.fileId), language: String(b.language ?? ''),
      hearingImpaired: !!b.hearingImpaired, forced: !!b.forced, release: typeof b.release === 'string' ? b.release.slice(0, 500) : null,
      score: typeof b.score === 'number' && Number.isFinite(b.score) ? Math.max(0, Math.min(100, Math.round(b.score))) : null,
    });
    return getItem(user, req.params.id, true);
  });
  /** Admin → Server settings → Subtitles: providers (built-in + plugins) in priority order, and external tools. */
  app.get('/admin/subtitles/providers', async (req) => {
    requireAdmin(req);
    return providerInfos();
  });
  app.get<{ Querystring: { refresh?: string } }>('/admin/subtitles/tools', async (req) => {
    requireAdmin(req);
    return subtitleTools(req.query.refresh === '1');
  });
  app.delete<{ Params: { id: string; index: string } }>('/items/:id/subtitles/:index', async (req) => {
    const a = requireAdmin(req);
    const m = db.get('SELECT id FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', req.params.id);
    if (!m) throw notFound();
    deleteDownloadedSubtitle(m.id, toInt(req.params.index, -1));
    return getItem(a.user, req.params.id, true);
  });

  /** AutoSync: retime a subtitle track against a correctly timed text track of the same file (time map, no restart). */
  app.post<{ Params: { id: string }; Body: AutoSyncRequest }>('/items/:id/subtitles/autosync', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    if (!req.body || typeof req.body !== 'object') throw badRequest('mediaId, subtitleIndex and referenceIndex are required');
    return autoSync(req.params.id, req.body);
  });

  /* --------------------------- skip segments ------------------------ */
  /** An admin's own segment timestamps ("Submit intro"), optionally sent on to IntroDB. */
  app.post<{ Params: { id: string }; Body: SubmitMarkerRequest }>('/items/:id/markers', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    return submitMarker(user, req.params.id, req.body);
  });
  app.get<{ Params: { id: string } }>('/items/:id/parental-guide', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    return parentalGuide(req.params.id);
  });

  /* -------------------------------- trakt --------------------------- */
  app.get('/trakt', async (req) => traktStatus(requireUser(req).user.id));
  app.post('/trakt/connect', async (req) => startDeviceAuth(requireUser(req).user.id));
  app.patch<{ Body: { scrobble: boolean } }>('/trakt', async (req) => {
    const { user } = requireUser(req);
    setScrobble(user.id, !!req.body?.scrobble);
    return traktStatus(user.id);
  });
  app.delete('/trakt', async (req) => {
    const { user } = requireUser(req);
    disconnect(user.id);
    return traktStatus(user.id);
  });
}
