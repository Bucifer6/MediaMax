/**
 * Requests (Overseerr/Jellyseerr parity): Discover, requests with permissions/quotas and the approval workflow,
 * blacklist, issues, notification agents and bulk user permissions.
 */
import type { FastifyInstance } from 'fastify';
import type {
  BulkRequestAction, BulkUpdateUsersRequest, CreateIssueRequest, CreateMediaRequest, EditMediaRequest, NotificationAgent, RequestListQuery, RequestMediaType, User,
} from '@mediamax/shared';
import { requireAdmin, requireUser } from '../http.js';
import { badRequest, notFound } from '../util/errors.js';
import { toInt } from '../util/misc.js';
import { db } from '../db.js';
import * as requests from '../services/requests.js';
import * as discoverPlus from '../services/discoverPlus.js';
import * as issues from '../services/issues.js';
import { allQuotaStatus } from '../services/requestPerms.js';
import { getUser, getUserRow, requestPermsPatch } from '../services/auth.js';
import { getSettings } from '../services/settings.js';
import { AGENT_KINDS, mergeAgents } from '../services/notify/kinds.js';
import { testAgent } from '../services/notify/agents.js';
import { initRequestNotifications } from '../services/requestEvents.js';
import { newId } from '../util/ids.js';

const bool = (v: unknown) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : undefined);

export default async function requestRoutes(app: FastifyInstance) {
  initRequestNotifications();

  /* ------------------------------ Discover ------------------------------ */
  app.get<{ Querystring: { q?: string; type?: 'movie' | 'show' | 'all'; page?: string; hideAvailable?: string } }>('/discover', async (req) =>
    requests.discover(requireUser(req).user, req.query.q ?? '', req.query.type ?? 'all', toInt(req.query.page, 1, 1, 50), { hideAvailable: bool(req.query.hideAvailable) }));
  app.get<{ Querystring: { hideAvailable?: string } }>('/discover/sliders', async (req) => discoverPlus.sliders(requireUser(req).user, bool(req.query.hideAvailable)));
  app.get<{ Params: { key: string }; Querystring: { page?: string; hideAvailable?: string } }>('/discover/list/:key', async (req) =>
    discoverPlus.listPage(requireUser(req).user, req.params.key, toInt(req.query.page, 1, 1, 50), bool(req.query.hideAvailable)));
  app.get('/discover/genres', async (req) => {
    requireUser(req);
    return discoverPlus.genres();
  });
  app.get<{ Params: { id: string } }>('/discover/person/:id', async (req) => discoverPlus.personPage(requireUser(req).user, req.params.id));
  app.get<{ Querystring: { q?: string } }>('/discover/people', async (req) => {
    requireUser(req);
    return discoverPlus.searchPeople(String(req.query.q ?? '').slice(0, 200));
  });
  app.get('/discover/watchlist', async (req) => discoverPlus.watchlist(requireUser(req).user));
  app.post<{ Body: { mediaType: 'movie' | 'show'; tmdbId: string } }>('/discover/watchlist', async (req) => discoverPlus.addToWatchlist(requireUser(req).user, req.body));
  app.delete<{ Params: { type: string; id: string } }>('/discover/watchlist/:type/:id', async (req) => {
    discoverPlus.removeFromWatchlist(requireUser(req).user, req.params.type, req.params.id);
    return { ok: true };
  });

  /* ------------------------------ requests ------------------------------ */
  app.get<{ Querystring: Record<string, string | undefined> }>('/requests', async (req) => {
    const q = req.query;
    const filter: RequestListQuery = {
      status: (q.status || undefined) as RequestListQuery['status'], mine: q.mine === 'true', mediaType: (q.mediaType || undefined) as RequestMediaType | undefined,
      userId: q.userId || undefined, sort: (q.sort || undefined) as RequestListQuery['sort'], order: (q.order || undefined) as RequestListQuery['order'],
    };
    return requests.listRequests(requireUser(req).user, filter);
  });
  app.get('/requests/quota', async (req) => allQuotaStatus(requireUser(req).user));
  app.get<{ Params: { tmdbId: string } }>('/requests/tv/:tmdbId', async (req) => {
    requireUser(req);
    return requests.tvInfo(req.params.tmdbId);
  });
  app.post<{ Body: CreateMediaRequest }>('/requests', async (req) => requests.createRequest(requireUser(req).user, req.body ?? ({} as CreateMediaRequest)));
  app.post<{ Body: BulkRequestAction }>('/requests/bulk', async (req) => requests.bulkRequests(requireUser(req).user, req.body ?? ({} as BulkRequestAction)));

  app.get('/requests/blacklist', async (req) => requests.listBlacklist(requireUser(req).user));
  app.post<{ Body: { mediaType: RequestMediaType; externalId: string; title?: string; reason?: string } }>('/requests/blacklist', async (req) =>
    requests.addToBlacklist(requireUser(req).user, req.body ?? ({} as never)));
  app.delete<{ Params: { type: string; id: string } }>('/requests/blacklist/:type/:id', async (req) => {
    requests.removeFromBlacklist(requireUser(req).user, req.params.type, req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/requests/:id', async (req) => requests.getRequest(requireUser(req).user, req.params.id));
  app.patch<{ Params: { id: string }; Body: EditMediaRequest }>('/requests/:id', async (req) => requests.editRequest(requireUser(req).user, req.params.id, req.body ?? {}));
  app.post<{ Params: { id: string }; Body: EditMediaRequest | undefined }>('/requests/:id/approve', async (req) => requests.approveRequest(requireUser(req).user, req.params.id, req.body ?? undefined));
  app.post<{ Params: { id: string } }>('/requests/:id/retry', async (req) => requests.approveRequest(requireUser(req).user, req.params.id));
  app.post<{ Params: { id: string }; Body: { note?: string; reason?: string } }>('/requests/:id/decline', async (req) =>
    requests.declineRequest(requireUser(req).user, req.params.id, req.body?.reason ?? req.body?.note));
  app.delete<{ Params: { id: string }; Querystring: { removeFromArr?: string } }>('/requests/:id', async (req) =>
    requests.deleteRequest(requireUser(req).user, req.params.id, { removeFromArr: req.query.removeFromArr === 'true' }));
  app.get<{ Params: { id: string } }>('/requests/:id/activity', async (req) => requests.requestActivity(requireUser(req).user, req.params.id));
  app.post<{ Params: { id: string }; Body: { body: string } }>('/requests/:id/comments', async (req) => requests.addComment(requireUser(req).user, req.params.id, req.body?.body));
  app.get<{ Params: { id: string } }>('/requests/:id/arr-options', async (req) => requests.requestArrChoices(requireUser(req).user, req.params.id));

  /* ------------------------------ issues ------------------------------ */
  app.get<{ Querystring: { status?: string; mine?: string; kind?: string } }>('/issues', async (req) =>
    issues.listIssues(requireUser(req).user, { status: req.query.status, mine: req.query.mine === 'true', kind: req.query.kind }));
  app.get('/issues/count', async (req) => ({ open: issues.openIssueCount(requireUser(req).user) }));
  app.post<{ Body: CreateIssueRequest }>('/issues', async (req) => issues.createIssue(requireUser(req).user, req.body ?? ({} as CreateIssueRequest)));
  app.get<{ Params: { id: string } }>('/issues/:id', async (req) => issues.getIssue(requireUser(req).user, req.params.id));
  app.post<{ Params: { id: string }; Body: { body: string } }>('/issues/:id/comments', async (req) => issues.commentIssue(requireUser(req).user, req.params.id, req.body?.body));
  app.post<{ Params: { id: string } }>('/issues/:id/resolve', async (req) => issues.setIssueStatus(requireUser(req).user, req.params.id, 'resolved'));
  app.post<{ Params: { id: string } }>('/issues/:id/reopen', async (req) => issues.setIssueStatus(requireUser(req).user, req.params.id, 'open'));
  app.delete<{ Params: { id: string } }>('/issues/:id', async (req) => {
    issues.deleteIssue(requireUser(req).user, req.params.id);
    return { ok: true };
  });

  /* ------------------------------ notification agents ------------------------------ */
  app.get('/notify/agents/kinds', async (req) => {
    requireAdmin(req);
    return AGENT_KINDS;
  });
  /** Test a saved agent (by id, with the stored secrets) or an unsaved draft. */
  app.post<{ Body: Partial<NotificationAgent> }>('/notify/agents/test', async (req) => {
    requireAdmin(req);
    const cur = getSettings().notificationAgents ?? [];
    const [agent] = mergeAgents([req.body ?? {}], cur, newId);
    if (!agent) throw badRequest('Unknown agent kind');
    return testAgent(agent);
  });

  /* ------------------------------ users: bulk permissions ------------------------------ */
  app.patch<{ Body: BulkUpdateUsersRequest }>('/users/bulk', async (req) => {
    requireAdmin(req);
    const b = req.body ?? ({} as BulkUpdateUsersRequest);
    const ids = Array.isArray(b.userIds) ? [...new Set(b.userIds.map(String))].slice(0, 1000) : [];
    if (!ids.length) throw badRequest('Pick at least one user');
    const updated: User[] = [];
    db.tx(() => {
      for (const id of ids) {
        const cur = getUserRow(id);
        if (!cur) throw notFound('User not found');
        const patch = requestPermsPatch(cur, { requestPermissions: b.requestPermissions, requestQuotas: b.requestQuotas });
        for (const [k, col] of [['allowLiveTv', 'allow_live_tv'], ['allowDownloads', 'allow_downloads'], ['allowTranscode', 'allow_transcode'], ['allowDvr', 'allow_dvr'], ['allowRemote', 'allow_remote']] as const) {
          if (b[k] !== undefined) patch[col] = !!b[k];
        }
        db.update('users', id, patch);
      }
    });
    for (const id of ids) updated.push(getUser(id));
    return updated;
  });
}
