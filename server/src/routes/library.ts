import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { CreateCollectionRequest, CreateLibraryRequest, CreatePlaylistRequest, ItemQuery, ItemSort, SearchResponse, UpdateItemRequest, UpdateLibraryRequest } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, requireUser } from '../http.js';
import { allowedLibraryIds, addToContainer, buildHome, createContainer, genres, getChildren, getContainer, getItem, listContainers, nextItem, queryItems, removeFromContainer, searchItems, setFavorite, setPlayed, setRating, similarItems, updateItem, reportProgress } from '../services/items.js';
import { scanLibrary, toLibrary } from '../services/scanner.js';
import { refreshItem } from '../services/metadata/index.js';
import { registerImage, resolveImage } from '../services/images.js';
import { ensureIptvDetails, searchLive } from '../services/livetv/livetv.js';
import { logActivity } from '../services/activity.js';
import { badRequest, notFound } from '../util/errors.js';
import { newId } from '../util/ids.js';
import { nowIso, toInt } from '../util/misc.js';
import { detectSeason } from '../services/introdetect.js';
import { similarTo } from '../services/recommend.js';

const LIB_TYPES = ['movies', 'shows', 'music', 'photos', 'videos', 'audiobooks'];

export default async function libraryRoutes(app: FastifyInstance) {
  /* ------------------------------ libraries ------------------------- */
  app.get('/libraries', async (req) => {
    const { user } = requireUser(req);
    const allowed = new Set(allowedLibraryIds(user));
    return db.all('SELECT * FROM libraries ORDER BY sort_order, name').filter((l) => allowed.has(l.id)).map(toLibrary);
  });

  app.post<{ Body: CreateLibraryRequest }>('/libraries', async (req) => {
    const a = requireAdmin(req);
    const b = req.body ?? ({} as CreateLibraryRequest);
    if (!b.name?.trim()) throw badRequest('Name is required');
    if (!LIB_TYPES.includes(b.type)) throw badRequest('Invalid library type');
    const paths = (b.paths ?? []).map((p) => path.resolve(p.trim())).filter(Boolean);
    if (!paths.length) throw badRequest('At least one folder is required');
    for (const p of paths) if (!fs.existsSync(p)) throw badRequest(`Folder not found on the server: ${p}`);
    const id = newId();
    const max = db.get<{ m: number | null }>('SELECT MAX(sort_order) m FROM libraries')?.m ?? 0;
    db.insert('libraries', { id, name: b.name.trim(), type: b.type, paths: JSON.stringify(paths), fetch_metadata: b.fetchMetadata ?? true, sort_order: (max ?? 0) + 1, created_at: nowIso() });
    logActivity('library.create', `Library "${b.name}" created`, { userId: a.user.id, userName: a.user.displayName });
    void scanLibrary(id);
    return toLibrary(db.get('SELECT * FROM libraries WHERE id = ?', id)!);
  });

  app.patch<{ Params: { id: string }; Body: UpdateLibraryRequest }>('/libraries/:id', async (req) => {
    requireAdmin(req);
    const lib = db.get('SELECT * FROM libraries WHERE id = ?', req.params.id);
    if (!lib) throw notFound('Library not found');
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (b.name) patch.name = b.name.trim();
    if (b.fetchMetadata !== undefined) patch.fetch_metadata = b.fetchMetadata;
    if (b.sortOrder !== undefined) patch.sort_order = b.sortOrder;
    if (b.paths && !String(lib.type).startsWith('iptv-')) {
      const paths = b.paths.map((p) => path.resolve(p.trim()));
      for (const p of paths) if (!fs.existsSync(p)) throw badRequest(`Folder not found on the server: ${p}`);
      patch.paths = JSON.stringify(paths);
    }
    db.update('libraries', req.params.id, patch);
    if (patch.paths) void scanLibrary(req.params.id);
    return toLibrary(db.get('SELECT * FROM libraries WHERE id = ?', req.params.id)!);
  });

  app.delete<{ Params: { id: string } }>('/libraries/:id', async (req) => {
    const a = requireAdmin(req);
    const lib = db.get('SELECT * FROM libraries WHERE id = ?', req.params.id);
    if (!lib) throw notFound('Library not found');
    db.run('DELETE FROM libraries WHERE id = ?', req.params.id);
    logActivity('library.delete', `Library "${lib.name}" removed`, { userId: a.user.id, userName: a.user.displayName });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { refreshMetadata?: boolean } }>('/libraries/:id/scan', async (req) => {
    requireAdmin(req);
    if (!db.get('SELECT 1 FROM libraries WHERE id = ?', req.params.id)) throw notFound('Library not found');
    void scanLibrary(req.params.id, { refreshMetadata: !!req.body?.refreshMetadata });
    return { ok: true };
  });

  app.post('/libraries/scan', async (req) => {
    requireAdmin(req);
    for (const l of db.all<{ id: string }>('SELECT id FROM libraries')) void scanLibrary(l.id);
    return { ok: true };
  });

  /* -------------------------------- items --------------------------- */
  app.get<{ Querystring: ItemQuery & Record<string, string> }>('/items', async (req) => {
    const { user } = requireUser(req);
    const q = req.query;
    return queryItems(user, {
      ...q,
      played: q.played === undefined ? undefined : String(q.played) === 'true',
      favorite: q.favorite === undefined ? undefined : String(q.favorite) === 'true',
      year: q.year ? Number(q.year) : undefined,
      limit: toInt(q.limit, 50, 1, 500),
      offset: toInt(q.offset, 0, 0),
    });
  });

  app.get<{ Params: { id: string } }>('/items/:id', async (req) => {
    const { user } = requireUser(req);
    await ensureIptvDetails(req.params.id);
    return getItem(user, req.params.id, true);
  });

  app.get<{ Params: { id: string }; Querystring: { sort?: ItemSort; order?: 'asc' | 'desc'; limit?: string; offset?: string } }>('/items/:id/children', async (req) => {
    const { user } = requireUser(req);
    await ensureIptvDetails(req.params.id);
    return getChildren(user, req.params.id, { sort: req.query.sort, order: req.query.order, limit: toInt(req.query.limit, 500, 1, 2000), offset: toInt(req.query.offset, 0, 0) });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/items/:id/similar', async (req) => {
    const { user } = requireUser(req);
    const limit = toInt(req.query.limit, 12, 1, 50);
    // Movies and shows use the recommendation engine's similarity (genres, cast, crew, studio, era, co-watching).
    return similarTo(user, req.params.id, limit) ?? similarItems(user, req.params.id, limit);
  });
  app.get<{ Params: { id: string } }>('/items/:id/next', async (req) => nextItem(requireUser(req).user, req.params.id));

  app.post<{ Params: { id: string } }>('/items/:id/played', async (req) => setPlayed(requireUser(req).user, req.params.id, true));
  app.delete<{ Params: { id: string } }>('/items/:id/played', async (req) => setPlayed(requireUser(req).user, req.params.id, false));
  app.post<{ Params: { id: string } }>('/items/:id/favorite', async (req) => setFavorite(requireUser(req).user, req.params.id, true));
  app.delete<{ Params: { id: string } }>('/items/:id/favorite', async (req) => setFavorite(requireUser(req).user, req.params.id, false));
  app.post<{ Params: { id: string }; Body: { rating: number | null } }>('/items/:id/rating', async (req) => setRating(requireUser(req).user, req.params.id, req.body?.rating ?? null));
  app.post<{ Params: { id: string }; Body: { positionMs: number; durationMs?: number; state: 'playing' | 'paused' | 'stopped' } }>('/items/:id/progress', async (req) => {
    const b = req.body ?? ({} as any);
    return reportProgress(requireUser(req).user, req.params.id, Number(b.positionMs) || 0, b.durationMs, b.state);
  });

  app.patch<{ Params: { id: string }; Body: UpdateItemRequest }>('/items/:id', async (req) => {
    const a = requireAdmin(req);
    updateItem(req.params.id, req.body ?? {});
    return getItem(a.user, req.params.id, true);
  });

  app.post<{ Params: { id: string } }>('/items/:id/refresh', async (req) => {
    const a = requireAdmin(req);
    const row = db.get('SELECT type, parent_id FROM items WHERE id = ?', req.params.id);
    if (!row) throw notFound('Item not found');
    db.run('UPDATE items SET metadata_fetched_at = NULL WHERE id = ?', req.params.id);
    await refreshItem(req.params.id);
    await ensureIptvDetails(req.params.id);
    return getItem(a.user, req.params.id, true);
  });

  app.post<{ Params: { id: string } }>('/items/:id/detect-intros', async (req) => {
    const a = requireAdmin(req);
    const row = db.get('SELECT type, parent_id FROM items WHERE id = ?', req.params.id);
    if (!row) throw notFound('Item not found');
    const seasonIds = row.type === 'season' ? [req.params.id] : row.type === 'episode' ? [row.parent_id] : row.type === 'show' ? db.all<{ id: string }>("SELECT id FROM items WHERE parent_id = ? AND type = 'season'", req.params.id).map((r) => r.id) : [];
    let n = 0;
    for (const s of seasonIds) n += await detectSeason(s, true);
    return { ok: true, updated: n, item: getItem(a.user, req.params.id, true) };
  });

  app.post<{ Params: { id: string; kind: string } }>('/items/:id/images/:kind', async (req) => {
    const a = requireAdmin(req);
    const kind = req.params.kind;
    if (!['poster', 'backdrop', 'logo', 'thumb'].includes(kind)) throw badRequest('Invalid image kind');
    if (!db.get('SELECT 1 FROM items WHERE id = ?', req.params.id)) throw notFound('Item not found');
    const file = await req.file();
    if (!file) throw badRequest('No file uploaded');
    const ext = path.extname(file.filename).toLowerCase() || '.jpg';
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) throw badRequest('Use a JPG, PNG or WebP image');
    const dir = path.join(config.dataDir, 'artwork');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${req.params.id}-${kind}-${Date.now()}${ext}`);
    fs.writeFileSync(dest, await file.toBuffer());
    const locked = JSON.parse(db.get('SELECT locked_fields FROM items WHERE id = ?', req.params.id)!.locked_fields || '[]') as string[];
    db.run(`UPDATE items SET ${kind} = ?, locked_fields = ? WHERE id = ?`, registerImage(dest), JSON.stringify([...new Set([...locked, kind])]), req.params.id);
    return getItem(a.user, req.params.id, true);
  });

  app.delete<{ Params: { id: string } }>('/items/:id', async (req) => {
    requireAdmin(req);
    db.run('DELETE FROM items WHERE id = ? OR parent_id = ? OR grandparent_id = ?', req.params.id, req.params.id, req.params.id);
    return { ok: true };
  });

  app.get<{ Querystring: { libraryId?: string } }>('/genres', async (req) => genres(requireUser(req).user, req.query.libraryId));

  app.get('/home', async (req) => ({ rows: buildHome(requireUser(req).user) }));

  app.get<{ Querystring: { q?: string; limit?: string } }>('/search', async (req): Promise<SearchResponse> => {
    const { user } = requireUser(req);
    const q = (req.query.q ?? '').trim();
    if (q.length < 1) return { items: [], channels: [], programs: [] };
    const limit = toInt(req.query.limit, 30, 1, 100);
    const live = searchLive(user, q, Math.min(limit, 20));
    return { items: searchItems(user, q, limit), channels: live.channels, programs: live.programs };
  });

  app.get<{ Params: { id: string }; Querystring: { w?: string } }>('/images/:id', async (req, reply) => {
    const img = await resolveImage(req.params.id, req.query.w ? toInt(req.query.w, 0, 0, 4000) : undefined);
    reply.header('Cache-Control', 'public, max-age=604800').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox").type(img.mime);
    return fs.createReadStream(img.path);
  });

  /* ------------------------- collections/playlists ------------------ */
  app.get('/collections', async (req) => listContainers(requireUser(req).user, 'collection'));
  app.post<{ Body: CreateCollectionRequest }>('/collections', async (req) => {
    const a = requireAdmin(req);
    if (!req.body?.title) throw badRequest('Title required');
    const id = createContainer('collection', req.body.title, null, req.body.itemIds ?? [], req.body.overview);
    return getItem(a.user, id, false);
  });
  app.post<{ Params: { id: string }; Body: { itemIds: string[] } }>('/collections/:id/items', async (req) => {
    const a = requireAdmin(req);
    getContainer(req.params.id, 'collection', a.user);
    addToContainer(req.params.id, req.body?.itemIds ?? []);
    return getItem(a.user, req.params.id, false);
  });
  app.delete<{ Params: { id: string; itemId: string } }>('/collections/:id/items/:itemId', async (req) => {
    const a = requireAdmin(req);
    getContainer(req.params.id, 'collection', a.user);
    removeFromContainer(req.params.id, req.params.itemId);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/collections/:id', async (req) => {
    const a = requireAdmin(req);
    getContainer(req.params.id, 'collection', a.user);
    db.run('DELETE FROM items WHERE id = ?', req.params.id);
    return { ok: true };
  });

  app.get('/playlists', async (req) => listContainers(requireUser(req).user, 'playlist'));
  app.post<{ Body: CreatePlaylistRequest }>('/playlists', async (req) => {
    const { user } = requireUser(req);
    if (!req.body?.title) throw badRequest('Title required');
    const id = createContainer('playlist', req.body.title, user.id, req.body.itemIds ?? []);
    return getItem(user, id, false);
  });
  app.post<{ Params: { id: string }; Body: { itemIds: string[] } }>('/playlists/:id/items', async (req) => {
    const { user } = requireUser(req);
    getContainer(req.params.id, 'playlist', user);
    addToContainer(req.params.id, req.body?.itemIds ?? []);
    return getItem(user, req.params.id, false);
  });
  app.delete<{ Params: { id: string; itemId: string } }>('/playlists/:id/items/:itemId', async (req) => {
    const { user } = requireUser(req);
    getContainer(req.params.id, 'playlist', user);
    removeFromContainer(req.params.id, req.params.itemId);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/playlists/:id', async (req) => {
    const { user } = requireUser(req);
    getContainer(req.params.id, 'playlist', user);
    db.run('DELETE FROM items WHERE id = ?', req.params.id);
    return { ok: true };
  });
}
