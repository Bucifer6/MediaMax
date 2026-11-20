import type { FastifyInstance } from 'fastify';
import type { ArrSearchRequest, ArrTestRequest } from '@mediamax/shared';
import { requireAdmin, requireUser } from '../http.js';
import { badRequest, unauthorized } from '../util/errors.js';
import { securityEvent } from '../util/securityLog.js';
import { toInt } from '../util/misc.js';
import { logActivity } from '../services/activity.js';
import { arrOptions, testConn } from '../services/arr/client.js';
import { bazarrSearch, getCalendar, getHealth, getQueue, getWanted, itemInfo, search } from '../services/arr/dashboard.js';
import { handleWebhook, regenerateWebhookToken, tokenMatches, webhookInfo } from '../services/arr/webhook.js';
import { discoverArr, requestOptions } from '../services/requests.js';

/** *arr suite: instance tests, downloads dashboard, webhooks, music/book discovery. */
export default async function arrRoutes(app: FastifyInstance) {
  /* ------------------------------ settings ---------------------------- */
  app.post<{ Body: ArrTestRequest }>('/arr/test', async (req) => {
    requireAdmin(req);
    return arrOptions(testConn(req.body ?? ({} as ArrTestRequest)));
  });
  app.get('/arr/webhook', async (req) => {
    requireAdmin(req);
    return webhookInfo();
  });
  app.post('/arr/webhook/regenerate', async (req) => {
    const a = requireAdmin(req);
    regenerateWebhookToken();
    logActivity('settings', '*arr webhook token regenerated', { userId: a.user.id, userName: a.user.displayName });
    return webhookInfo();
  });

  /* -------------------------- webhook receiver ------------------------ */
  // Unauthenticated: the random token in the path is the secret. Configure it in each *arr under
  // Settings → Connect → Webhook (events On Import/Upgrade/Rename/Delete).
  app.post<{ Params: { token: string } }>('/arr/webhook/:token', async (req) => {
    if (!tokenMatches(req.params.token)) {
      securityEvent('AUTH_FAIL', req.ip, { reason: 'arr_webhook' });
      throw unauthorized('Invalid webhook token');
    }
    const body = req.body;
    if (!body || typeof body !== 'object') throw badRequest('JSON body required');
    return handleWebhook(body);
  });

  /* ----------------------------- dashboard ---------------------------- */
  app.get('/arr/queue', async (req) => {
    requireAdmin(req);
    return getQueue();
  });
  app.get<{ Querystring: { days?: string } }>('/arr/calendar', async (req) => {
    requireAdmin(req);
    return getCalendar(toInt(req.query.days, 14, 1, 60));
  });
  app.get('/arr/wanted', async (req) => {
    requireAdmin(req);
    return getWanted();
  });
  app.get('/arr/health', async (req) => {
    requireAdmin(req);
    return getHealth();
  });
  app.post<{ Params: { instanceId: string }; Body: ArrSearchRequest }>('/arr/:instanceId/search', async (req) => {
    const a = requireAdmin(req);
    const out = await search(req.params.instanceId, req.body ?? ({} as ArrSearchRequest));
    logActivity('arr.search', `${a.user.displayName} started ${out.command}`, { userId: a.user.id, userName: a.user.displayName });
    return out;
  });

  /* --------------------------- item detail ---------------------------- */
  app.get<{ Params: { itemId: string } }>('/arr/item/:itemId', async (req) => {
    requireAdmin(req);
    return itemInfo(req.params.itemId);
  });
  app.post<{ Params: { itemId: string } }>('/arr/item/:itemId/subtitles', async (req) => {
    const a = requireAdmin(req);
    const out = await bazarrSearch(req.params.itemId);
    logActivity('arr.bazarr', out.message, { userId: a.user.id, userName: a.user.displayName });
    return out;
  });

  /* ------------------------ requests: options ------------------------- */
  app.get('/requests/options', async (req) => requestOptions(requireUser(req).user));
  app.get<{ Querystring: { kind?: string; q?: string } }>('/discover/arr', async (req) => {
    const { user } = requireUser(req);
    const kind = req.query.kind === 'books' ? 'books' : req.query.kind === 'music' ? 'music' : null;
    if (!kind) throw badRequest('kind must be music or books');
    return discoverArr(user, kind, String(req.query.q ?? '').slice(0, 200));
  });
}
