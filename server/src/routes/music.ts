import type { FastifyInstance } from 'fastify';
import type {
  AcoustIdCandidate, DiscographyResponse, IdentifyResponse, LbRecommendations, ListenBrainzStatus, ListenBrainzUpdate, MusicSettings, MusicSettingsResponse,
  RelatedArtistsResponse,
} from '@mediamax/shared';
import { requireAdmin, requireUser } from '../http.js';
import { db } from '../db.js';
import { assertCanSee, getItem } from '../services/items.js';
import { discography, relatedArtists } from '../services/music/musicbrainz.js';
import { applyIdentification, identifyTrack, musicSettingsState, unavailableReason } from '../services/music/acoustid.js';
import { updateMusicSettings } from '../services/music/settings.js';
import { flushQueue, lbConnect, lbDisconnect, lbRecommendations, lbSaveAsPlaylist, lbStatus } from '../services/listenbrainz.js';
import { runTask, isTaskRunning } from '../services/tasks.js';
import { logActivity } from '../services/activity.js';
import { badRequest } from '../util/errors.js';
import { parseJson } from '../util/misc.js';

/** MusicBrainz discography / related artists, AcoustID identification, ListenBrainz, music identification settings. */
export default async function musicRoutes(app: FastifyInstance) {
  const artistOf = (req: any, id: string) => {
    const { user } = requireUser(req);
    const row = assertCanSee(user, id);
    if (row.type !== 'artist') throw badRequest('Not an artist');
    return user;
  };

  app.get<{ Params: { id: string } }>('/music/artists/:id/discography', async (req): Promise<DiscographyResponse> => discography(artistOf(req, req.params.id), req.params.id));
  app.get<{ Params: { id: string } }>('/music/artists/:id/related', async (req): Promise<RelatedArtistsResponse> => relatedArtists(artistOf(req, req.params.id), req.params.id));

  /* ----------------------------- AcoustID ----------------------------- */
  // Last stored lookup for a track (Fix match → Identify by sound), without a new request.
  app.get<{ Params: { id: string } }>('/items/:id/identify', async (req): Promise<IdentifyResponse> => {
    requireAdmin(req);
    const reason = await unavailableReason();
    const r = db.get<{ candidates: string }>('SELECT candidates FROM acoustid_results WHERE item_id = ?', req.params.id);
    return { available: !reason, reason, candidates: parseJson<AcoustIdCandidate[]>(r?.candidates, []) };
  });
  app.post<{ Params: { id: string } }>('/items/:id/identify', async (req): Promise<IdentifyResponse> => {
    requireAdmin(req);
    return identifyTrack(req.params.id);
  });
  app.post<{ Params: { id: string }; Body: { candidate: AcoustIdCandidate } }>('/items/:id/identify/apply', async (req) => {
    const a = requireAdmin(req);
    const c = req.body?.candidate;
    if (!c || (!c.recordingMbid && !c.title)) throw badRequest('candidate is required');
    applyIdentification(req.params.id, c);
    logActivity('metadata', `Identified a track by sound as "${c.title ?? c.recordingMbid}"`, { userId: a.user.id, userName: a.user.displayName });
    return getItem(a.user, req.params.id);
  });

  /* -------------------------- admin settings -------------------------- */
  app.get('/admin/music', async (req): Promise<MusicSettingsResponse> => {
    requireAdmin(req);
    return musicSettingsState();
  });
  app.put<{ Body: Partial<MusicSettings> }>('/admin/music', async (req): Promise<MusicSettingsResponse> => {
    const a = requireAdmin(req);
    updateMusicSettings(req.body ?? {});
    logActivity('settings', 'Music identification settings updated', { userId: a.user.id, userName: a.user.displayName });
    return musicSettingsState();
  });
  app.post('/admin/music/identify-untagged', async (req) => {
    requireAdmin(req);
    if (!isTaskRunning('identify-untagged')) void runTask('identify-untagged').catch(() => undefined);
    return { ok: true };
  });

  /* ---------------------------- ListenBrainz ---------------------------- */
  app.get('/listenbrainz', async (req): Promise<ListenBrainzStatus> => lbStatus(requireUser(req).user.id));
  app.put<{ Body: ListenBrainzUpdate }>('/listenbrainz', async (req): Promise<ListenBrainzStatus> => lbConnect(requireUser(req).user, req.body ?? {}));
  app.delete('/listenbrainz', async (req): Promise<ListenBrainzStatus> => lbDisconnect(requireUser(req).user.id));
  app.post('/listenbrainz/flush', async (req): Promise<ListenBrainzStatus> => {
    const { user } = requireUser(req);
    await flushQueue(user.id);
    return lbStatus(user.id);
  });
  app.get<{ Querystring: { refresh?: string } }>('/listenbrainz/recommendations', async (req): Promise<LbRecommendations> =>
    lbRecommendations(requireUser(req).user, req.query.refresh === '1'));
  app.post<{ Params: { listId: string } }>('/listenbrainz/recommendations/:listId/playlist', async (req) => lbSaveAsPlaylist(requireUser(req).user, req.params.listId));
}
