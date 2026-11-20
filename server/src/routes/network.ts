import type { FastifyInstance } from 'fastify';
import type { NetworkSettings, NetworkStatus } from '@mediamax/shared';
import { requireAdmin } from '../http.js';
import { logActivity } from '../services/activity.js';
import { getSettings } from '../services/settings.js';
import { builtinStatus, envTrustedProxies, getNetwork, saveNetwork, trustProxy } from '../services/network.js';

/** Admin → Network: direct, behind your own reverse proxy, or built-in HTTPS (managed Caddy). */
export default async function networkRoutes(app: FastifyInstance) {
  app.get('/admin/network', async (req): Promise<NetworkStatus> => {
    requireAdmin(req);
    const socketAddress = req.socket.remoteAddress ?? '';
    const xff = req.headers['x-forwarded-for'];
    const xfp = req.headers['x-forwarded-proto'];
    return {
      settings: getNetwork(),
      envTrustedProxies: envTrustedProxies(),
      you: {
        ip: req.ip, socketAddress, forwardedFor: Array.isArray(xff) ? xff.join(', ') : xff ?? null,
        forwardedProto: Array.isArray(xfp) ? xfp[0] : xfp ?? null, proxyTrusted: !!xff && trustProxy(socketAddress, 0),
        protocol: req.protocol, host: req.host,
      },
      publicUrl: getSettings().publicUrl ?? null,
      builtin: await builtinStatus(),
    };
  });
  app.put<{ Body: Partial<NetworkSettings> }>('/admin/network', async (req) => {
    const a = requireAdmin(req);
    const s = saveNetwork(req.body ?? {});
    logActivity('settings', `Network mode set to ${s.mode}${s.mode === 'builtin' ? ` (built-in HTTPS for ${s.builtinHttps.domain})` : ''}`, { userId: a.user.id, userName: a.user.displayName });
    return s;
  });
}
