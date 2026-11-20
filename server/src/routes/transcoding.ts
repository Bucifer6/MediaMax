import type { FastifyInstance } from 'fastify';
import type { HwDetectReport } from '@mediamax/shared';
import { requireAdmin } from '../http.js';
import { cachedReport, detectHardware } from '../services/hwdetect.js';

/** Hardware transcoding detection (Server settings → Transcoding → Detect hardware). */
export default async function transcodingRoutes(app: FastifyInstance) {
  /** The last detection report from this server session, or null when it has not run yet. */
  app.get('/admin/transcoding/detect', async (req): Promise<{ report: HwDetectReport | null }> => {
    requireAdmin(req);
    return { report: cachedReport() };
  });

  /** Run detection now: list devices and encoders, then run short test transcodes for every method. */
  app.post('/admin/transcoding/detect', async (req): Promise<{ report: HwDetectReport }> => {
    requireAdmin(req);
    return { report: await detectHardware() };
  });
}
