import type { FastifyInstance } from 'fastify';
import { requireUser } from '../http.js';
import { toInt } from '../util/misc.js';
import { buildWrapped } from '../services/wrapped.js';

/** The animated Wrapped story: your own history only. */
export default async function wrappedRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { year?: string } }>('/stats/me/wrapped', async (req) => {
    const { user } = requireUser(req);
    const y = req.query.year;
    return buildWrapped(user.id, y && y !== 'all' ? toInt(y, new Date().getFullYear(), 2000, 2100) : null);
  });
}
