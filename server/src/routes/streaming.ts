/**
 * Client-rendered subtitles (raw formats, embedded fonts) and the bandwidth probe used for adaptive streaming.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db.js';
import { requireUser } from '../http.js';
import { assertCanSee } from '../services/items.js';
import { badRequest, HttpError, notFound } from '../util/errors.js';
import { extractSubtitle, fontFile, listFonts, partialContent, rawMime, settle, type RawExt } from '../services/subtitles.js';
import { streamingSettings } from '../services/abr.js';

const tokenQuery = (token: string) => `?token=${encodeURIComponent(token)}`;

function assertMedia(req: FastifyRequest, mediaId: string) {
  const { user } = requireUser(req);
  const m = db.get<{ item_id: string }>('SELECT item_id FROM media WHERE id = ?', mediaId);
  if (!m) throw notFound('Media not found');
  assertCanSee(user, m.item_id);
}

/**
 * GET /stream/subtitles/:mediaId/:index[.vtt|.srt|.ass|.ssa|.sup][?partial=1]
 * Without `partial` the response waits for the whole track (the legacy WebVTT behaviour). With it, the response is
 * whatever has been extracted after ~1.5 s, flagged with X-Subtitle-Complete / X-Subtitle-Progress.
 */
export async function serveSubtitle(req: FastifyRequest<{ Params: { mediaId: string; index: string }; Querystring: { partial?: string } }>, reply: FastifyReply) {
  assertMedia(req, req.params.mediaId);
  const m = req.params.index.match(/^(\d+)(?:\.(vtt|srt|ass|ssa|sup))?$/i);
  if (!m) throw notFound();
  const index = parseInt(m[1], 10);
  const ext = (m[2]?.toLowerCase() === 'ssa' ? 'ass' : m[2]?.toLowerCase() ?? 'vtt') as RawExt;
  const ex = extractSubtitle(req.params.mediaId, index, ext);
  const partial = req.query.partial === '1' || req.query.partial === 'true';
  if (partial) await settle(ex, 1500);
  else {
    try {
      await ex.done;
    } catch (e) {
      throw new HttpError(500, `Subtitle extraction failed: ${(e as Error).message}`, 'subtitle_failed');
    }
  }
  if (ex.failed) throw new HttpError(500, `Subtitle extraction failed: ${ex.failed}`, 'subtitle_failed');
  reply.type(rawMime(ext));
  reply.header('X-Subtitle-Complete', ex.complete ? '1' : '0');
  if (ex.progress != null) reply.header('X-Subtitle-Progress', ex.progress.toFixed(3));
  reply.header('Access-Control-Expose-Headers', 'X-Subtitle-Complete, X-Subtitle-Progress');
  if (!ex.complete) {
    reply.header('Cache-Control', 'no-store');
    return reply.send(partialContent(ex));
  }
  reply.header('Cache-Control', 'private, max-age=86400');
  return reply.send(fs.createReadStream(ex.file));
}

/* --------------------------- bandwidth probe --------------------------- */

/** Random (incompressible) bytes, generated once and served from random offsets. */
const POOL_SIZE = 1 << 20;
let pool: Buffer | null = null;
const randomPool = () => (pool ??= crypto.randomBytes(POOL_SIZE));

export const BANDWIDTH_MIN_BYTES = 8 * 1024;
/** Per-user limits: requests and bytes per rolling minute. */
export const BANDWIDTH_RATE = { windowMs: 60_000, maxRequests: 30, maxBytes: 200 * 1024 * 1024 };
const usage = new Map<string, { at: number; bytes: number }[]>();

/** Returns the clamped size, or throws 429 when the user is over the limit. Exported for tests. */
export function takeBandwidthBudget(userId: string, wanted: number, now = Date.now()): number {
  const max = streamingSettings().bandwidthTestMaxBytes;
  const bytes = Math.max(BANDWIDTH_MIN_BYTES, Math.min(max, Math.floor(Number.isFinite(wanted) ? wanted : 1024 * 1024)));
  const list = (usage.get(userId) ?? []).filter((u) => now - u.at < BANDWIDTH_RATE.windowMs);
  const used = list.reduce((a, u) => a + u.bytes, 0);
  if (list.length >= BANDWIDTH_RATE.maxRequests || used + bytes > BANDWIDTH_RATE.maxBytes) {
    usage.set(userId, list);
    throw new HttpError(429, 'Too many bandwidth tests, try again in a minute', 'rate_limited');
  }
  list.push({ at: now, bytes });
  usage.set(userId, list);
  return bytes;
}

export const resetBandwidthUsage = () => usage.clear();

function randomStream(total: number): Readable {
  const src = randomPool();
  let left = total;
  return new Readable({
    read() {
      if (left <= 0) return void this.push(null);
      const n = Math.min(left, 64 * 1024);
      const off = crypto.randomInt(0, POOL_SIZE - n + 1);
      left -= n;
      this.push(src.subarray(off, off + n));
    },
  });
}

export default async function streamingRoutes(app: FastifyInstance) {
  app.get<{ Params: { mediaId: string } }>('/stream/subtitles/:mediaId/fonts', async (req, reply) => {
    const a = requireUser(req);
    assertMedia(req, req.params.mediaId);
    reply.header('Cache-Control', 'private, max-age=3600');
    return listFonts(req.params.mediaId, tokenQuery(a.token));
  });

  app.get<{ Params: { mediaId: string; name: string } }>('/stream/subtitles/:mediaId/fonts/:name', async (req, reply) => {
    assertMedia(req, req.params.mediaId);
    const { file, mime } = await fontFile(req.params.mediaId, req.params.name);
    reply.type(mime).header('Cache-Control', 'private, max-age=604800');
    return reply.send(fs.createReadStream(file));
  });

  /**
   * GET /playback/bandwidth-test?bytes=N — N random bytes (clamped to 8 KiB … streaming.bandwidthTestMaxBytes),
   * never cached or compressed. Clients time the body download to estimate throughput.
   */
  app.get<{ Querystring: { bytes?: string } }>('/playback/bandwidth-test', async (req, reply) => {
    const { user } = requireUser(req);
    const wanted = req.query.bytes != null ? Number(req.query.bytes) : 1024 * 1024;
    if (!Number.isFinite(wanted) || wanted < 0) throw badRequest('bytes must be a positive number');
    const bytes = takeBandwidthBudget(user.id, wanted);
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', bytes)
      .header('Cache-Control', 'no-store, no-cache, no-transform, private, max-age=0')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .header('Content-Encoding', 'identity')
      .header('X-Bandwidth-Test-Bytes', String(bytes));
    return reply.send(randomStream(bytes));
  });
}
