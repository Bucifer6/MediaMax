import type { FastifyInstance } from 'fastify';
import type { SecurityBanRequest, SecurityDashboardSettings } from '@mediamax/shared';
import { requireAdmin } from '../http.js';
import { logActivity } from '../services/activity.js';
import { ban, getSecuritySettings, publicSecuritySettings, saveSecuritySettings, securityOverview, unban } from '../services/security/dashboard.js';

/** Admin → Security: proxy traffic, certificate, sign-in failures, CrowdSec and fail2ban (with ban/unban). */
export default async function securityRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>('/admin/security', async (req) => {
    requireAdmin(req);
    return securityOverview(req.query.refresh === '1');
  });
  app.get('/admin/security/settings', async (req) => {
    requireAdmin(req);
    return publicSecuritySettings();
  });
  app.put<{ Body: Partial<SecurityDashboardSettings> }>('/admin/security/settings', async (req) => {
    const a = requireAdmin(req);
    const s = saveSecuritySettings(req.body ?? {});
    logActivity('settings', 'Security dashboard connections updated', { userId: a.user.id, userName: a.user.displayName });
    return s;
  });
  app.post<{ Body: SecurityBanRequest }>('/admin/security/ban', async (req) => {
    const a = requireAdmin(req);
    await ban(req.body ?? ({} as SecurityBanRequest), req.ip);
    logActivity('security', `${a.user.displayName} banned ${req.body.ip} via ${req.body.tool ?? 'crowdsec'}${req.body.reason ? ` (${req.body.reason})` : ''}`, { userId: a.user.id, userName: a.user.displayName, severity: 'warning' });
    return { ok: true };
  });
  app.post<{ Body: SecurityBanRequest }>('/admin/security/unban', async (req) => {
    const a = requireAdmin(req);
    const where = await unban(req.body ?? ({} as SecurityBanRequest));
    logActivity('security', `${a.user.displayName} unbanned ${req.body.ip}${where.length ? ` (${where.join(', ')})` : ' (it was not banned)'}`, { userId: a.user.id, userName: a.user.displayName });
    return { ok: true, removedFrom: where, configured: !!(getSecuritySettings().crowdsec.url || getSecuritySettings().fail2banSocket) };
  });
}
