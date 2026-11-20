import type { FastifyInstance } from 'fastify';
import { requireUser } from '../http.js';
import { listWatchlist, setNotInterested, setWatchlist } from '../services/items.js';
import { calendarFor } from '../services/calendar.js';
import { listNotifications, markRead } from '../services/notifications.js';
import '../services/recommend.js';
import { toInt } from '../util/misc.js';

/** My List, "not interested", the upcoming-episodes calendar and in-app notifications. */
export default async function discoveryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/watchlist', async (req) =>
    listWatchlist(requireUser(req).user, toInt(req.query.limit, 100, 1, 500), toInt(req.query.offset, 0, 0)));
  app.post<{ Params: { id: string } }>('/items/:id/watchlist', async (req) => setWatchlist(requireUser(req).user, req.params.id, true));
  app.delete<{ Params: { id: string } }>('/items/:id/watchlist', async (req) => setWatchlist(requireUser(req).user, req.params.id, false));

  app.post<{ Params: { id: string } }>('/items/:id/not-interested', async (req) => setNotInterested(requireUser(req).user, req.params.id, true));
  app.delete<{ Params: { id: string } }>('/items/:id/not-interested', async (req) => setNotInterested(requireUser(req).user, req.params.id, false));

  app.get<{ Querystring: { from?: string; to?: string } }>('/calendar', async (req) => calendarFor(requireUser(req).user, req.query.from, req.query.to));

  app.get<{ Querystring: { limit?: string; unread?: string } }>('/notifications', async (req) =>
    listNotifications(requireUser(req).user, toInt(req.query.limit, 50, 1, 200), req.query.unread === 'true'));
  app.post<{ Body: { ids?: string[] } }>('/notifications/read', async (req) => markRead(requireUser(req).user, Array.isArray(req.body?.ids) ? req.body.ids : null));
}
