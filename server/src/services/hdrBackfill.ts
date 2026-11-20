/**
 * Fill in `media.video_range` (HDR format / Dolby Vision profile) for files scanned before HDR detection existed.
 * Only rows flagged HDR need a re-probe (SDR is implied by hdr = 0). Runs as the "Detect HDR formats" task and on
 * demand when such a file is played.
 */
import fs from 'node:fs';
import type { VideoRangeInfo } from '@mediamax/shared';
import { db } from '../db.js';
import { ffprobeJson, firstFrameSideData } from './probe.js';
import { parseVideoRange, wantsFrameProbe } from './hdr.js';
import { logger } from '../util/log.js';

const log = logger('hdr');

/** Probe one media row's video stream and store its VideoRangeInfo. Returns null when it can't be probed. */
export async function refreshVideoRange(mediaId: string): Promise<VideoRangeInfo | null> {
  const m = db.get<{ path: string | null }>('SELECT path FROM media WHERE id = ?', mediaId);
  if (!m?.path || !fs.existsSync(m.path)) return null;
  const j = await ffprobeJson(m.path, ['-select_streams', 'v'], 30000);
  const video = (j.streams ?? []).find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) return null;
  const sd = wantsFrameProbe(video) ? await firstFrameSideData(m.path, video.index) : [];
  const range = parseVideoRange(video, sd);
  if (range) db.run('UPDATE media SET video_range = ?, hdr = ? WHERE id = ?', JSON.stringify(range), range.hdrFormat !== 'sdr' ? 1 : 0, mediaId);
  return range;
}

export async function backfillVideoRanges(progress: (p: number) => void = () => {}): Promise<number> {
  const rows = db.all<{ id: string }>('SELECT id FROM media WHERE hdr = 1 AND video_range IS NULL AND path IS NOT NULL');
  let done = 0;
  for (const r of rows) {
    try {
      await refreshVideoRange(r.id);
    } catch (e) {
      log.warn(`HDR probe failed for media ${r.id}: ${(e as Error).message}`);
      // Mark as attempted so a broken file isn't re-probed forever.
      db.run("UPDATE media SET video_range = 'null' WHERE id = ?", r.id);
    }
    progress(Math.round((++done / rows.length) * 100));
  }
  if (rows.length) log.info(`Detected HDR formats for ${rows.length} file(s)`);
  return rows.length;
}
