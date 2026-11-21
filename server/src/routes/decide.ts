/**
 * "Help us decide": Movie Match (group swipe), Roulette and Random marathon. Every route needs a signed-in user;
 * all item access goes through the viewer's (and for Match, every member's) access rules.
 */
import type { FastifyInstance } from 'fastify';
import type { CreateMarathonRequest, CreateMatchRequest, MarathonNextRequest, MatchVote, RouletteSpinRequest } from '@mediamax/shared';
import { requireUser } from '../http.js';
import { spin } from '../services/decide/roulette.js';
import { moodPresets } from '../services/decide/common.js';
import { createMarathon, endMarathon, getMarathon, nextInMarathon } from '../services/decide/marathon.js';
import { createMatch, endMatch, extendMatch, getMatch, joinMatch, leaveMatch, matchDeck, matchResults, playOnHost, voteMatch } from '../services/decide/match.js';
import { toInt } from '../util/misc.js';

type Id = { Params: { id: string } };

export default async function decideRoutes(app: FastifyInstance) {
  /* ------------------------------ roulette ------------------------------ */
  app.get('/roulette/moods', async (req) => {
    requireUser(req);
    return moodPresets();
  });
  app.post<{ Body: RouletteSpinRequest }>('/roulette/spin', async (req) => spin(requireUser(req).user, req.body));

  /* ------------------------------ marathon ------------------------------ */
  app.post<{ Body: CreateMarathonRequest & { seed?: number } }>('/marathon', async (req) => createMarathon(requireUser(req).user, req.body ?? {}));
  app.get<Id>('/marathon/:id', async (req) => getMarathon(requireUser(req).user, req.params.id));
  app.post<Id & { Body: MarathonNextRequest }>('/marathon/:id/next', async (req) => nextInMarathon(requireUser(req).user, req.params.id, req.body ?? {}));
  app.delete<Id>('/marathon/:id', async (req) => {
    endMarathon(requireUser(req).user, req.params.id);
    return { ok: true };
  });

  /* ------------------------------- match -------------------------------- */
  app.post<{ Body: CreateMatchRequest & { seed?: number } }>('/match', async (req) => {
    const a = requireUser(req);
    return createMatch(a.user, { rowId: a.deviceRowId, name: a.device?.deviceName ?? null }, req.body);
  });
  app.post<{ Body: { code: string } }>('/match/join', async (req) => joinMatch(requireUser(req).user, req.body?.code));
  app.get<Id>('/match/:id', async (req) => getMatch(requireUser(req).user, req.params.id));
  app.get<Id & { Querystring: { offset?: string; limit?: string } }>('/match/:id/deck', async (req) =>
    matchDeck(requireUser(req).user, req.params.id, toInt(req.query.offset, 0, 0), toInt(req.query.limit, 20, 1, 60)));
  app.post<Id & { Body: { itemId: string; vote: MatchVote } }>('/match/:id/vote', async (req) =>
    voteMatch(requireUser(req).user, req.params.id, String(req.body?.itemId ?? ''), req.body?.vote));
  app.post<Id>('/match/:id/extend', async (req) => extendMatch(requireUser(req).user, req.params.id));
  app.get<Id>('/match/:id/results', async (req) => matchResults(requireUser(req).user, req.params.id));
  app.post<Id>('/match/:id/leave', async (req) => {
    leaveMatch(requireUser(req).user, req.params.id);
    return { ok: true };
  });
  app.post<Id>('/match/:id/end', async (req) => {
    endMatch(requireUser(req).user, req.params.id);
    return { ok: true };
  });
  app.post<Id & { Body: { itemId: string } }>('/match/:id/play', async (req) => {
    const a = requireUser(req);
    return playOnHost(a.user, req.params.id, String(req.body?.itemId ?? ''), a.device?.deviceName ?? 'A phone');
  });
}
