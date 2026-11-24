import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ImportMetadataResult } from '@mediamax/shared';
import { db } from '../../db.js';
import { config } from '../../config.js';
import { registerImage } from '../images.js';
import { logger } from '../../util/log.js';
import { nowIso, parseJson } from '../../util/misc.js';
import { type Matcher, type MetaImageKind, type Progress, type Session, type SrcMeta, type SrcSeries, pool } from './common.js';

/**
 * Import → metadata: copy the source server's metadata and artwork onto the Vibe titles it matches.
 *
 * - Text fields: overview, tagline, original title, genres, studios, cast/crew, content rating, community rating,
 *   release date. Artwork: poster, background, logo, episode still (`thumb`), season posters.
 * - By default only empty fields and missing artwork are filled; `overwrite` replaces what Vibe has. Fields in an
 *   item's `locked_fields` are never touched either way.
 * - Artwork is downloaded once into `<data>/artwork/import/` and registered as a local image, so it is served without
 *   asking the source again (the source may be switched off after the move) and rescans keep it.
 * - `metadata_fetched_at` is left alone, so a metadata provider (TMDB) can still enrich the title later.
 */

const log = logger('server-import');

const TEXT: { col: string; field: string; key: keyof SrcMeta }[] = [
  { col: 'overview', field: 'overview', key: 'overview' },
  { col: 'tagline', field: 'tagline', key: 'tagline' },
  { col: 'original_title', field: 'originalTitle', key: 'originalTitle' },
  { col: 'genres', field: 'genres', key: 'genres' },
  { col: 'studios', field: 'studios', key: 'studios' },
  { col: 'people', field: 'people', key: 'people' },
  { col: 'content_rating', field: 'contentRating', key: 'contentRating' },
  { col: 'community_rating', field: 'communityRating', key: 'communityRating' },
  { col: 'release_date', field: 'releaseDate', key: 'releaseDate' },
];

const MAX_IMAGE = 20 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };

const empty = (v: unknown) => v === null || v === undefined || v === '' || v === '[]';

/** A source value in the column's stored form, or undefined when the source has nothing useful. */
function stored(key: keyof SrcMeta, v: unknown): string | number | undefined {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    if (!v.length) return undefined;
    return JSON.stringify(key === 'people' ? (v as SrcMeta['people'])!.map((p) => ({ name: p.name, role: p.role ?? null, kind: p.kind, imageUrl: null })) : v);
  }
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

/** The Vibe id of a source title (seasons through their show), or null. */
function localId(matcher: Matcher, m: SrcMeta, series: Map<string, SrcSeries>): string | null {
  const it = m.item;
  const show = it.seriesId ? series.get(it.seriesId) ?? null : null;
  if (it.kind === 'season') {
    if (!show || it.season == null) return null;
    const sm = matcher.show(show);
    return sm ? db.get<{ id: string }>("SELECT id FROM items WHERE type = 'season' AND parent_id = ? AND idx = ?", sm.id, it.season)?.id ?? null : null;
  }
  if (it.kind === 'other') return null;
  return matcher.match(it, show)?.id ?? null;
}

/** Save downloaded artwork under the data dir; the name carries a content hash so a replaced image gets a new id. */
function saveImage(itemId: string, kind: MetaImageKind, data: Buffer, type: string): string | null {
  const t = type.toLowerCase().split(';')[0].trim();
  const ext = EXT[t];
  // Raster images only: never SVG or HTML from the source.
  if (!ext || !data.length || data.length > MAX_IMAGE) return null;
  const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 10);
  const dest = path.join(config.dataDir, 'artwork', 'import', itemId.slice(0, 2), `${itemId}-${kind}-${hash}${ext}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, data);
  return registerImage(dest);
}

export interface MetadataImportOptions { overwrite: boolean }

export async function importMetadata(session: Session, matcher: Matcher, o: MetadataImportOptions, progress: Progress): Promise<ImportMetadataResult> {
  const res: ImportMetadataResult = { read: 0, matched: 0, updated: 0, images: 0, imageErrors: 0 };
  if (!session.metadata || !session.fetchImage) return res;
  progress('Reading metadata', 0);
  const { items, series } = await session.metadata((phase, f) => progress(phase, (f ?? 0) * 0.2));
  res.read = items.length;

  // Text first (fast, synchronous); collect the artwork jobs.
  const jobs: { itemId: string; kind: MetaImageKind; ref: string }[] = [];
  const changed = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    const id = localId(matcher, m, series);
    if (!id) continue;
    const row = db.get<Record<string, unknown>>('SELECT * FROM items WHERE id = ?', id);
    if (!row) continue;
    res.matched++;
    const locked = new Set(parseJson<string[]>(row.locked_fields as string, []));
    const patch: Record<string, unknown> = {};
    for (const t of TEXT) {
      if (locked.has(t.field) || locked.has(t.col)) continue;
      const v = stored(t.key, m[t.key]);
      if (v === undefined || (!o.overwrite && !empty(row[t.col])) || row[t.col] === v) continue;
      patch[t.col] = v;
    }
    if (Object.keys(patch).length) {
      patch.updated_at = nowIso();
      db.update('items', id, patch);
      changed.add(id);
    }
    for (const [kind, ref] of Object.entries(m.images) as [MetaImageKind, string][]) {
      if (!ref || locked.has(kind) || (!o.overwrite && row[kind])) continue;
      jobs.push({ itemId: id, kind, ref });
    }
    if (i % 500 === 0) progress(`Applying metadata (${i} of ${items.length})`, 0.2 + (i / Math.max(1, items.length)) * 0.2);
  }

  // Then artwork, a few downloads at a time.
  let done = 0;
  await pool(jobs, 6, async (j) => {
    try {
      const img = await session.fetchImage!(j.ref);
      const imgId = img ? saveImage(j.itemId, j.kind, img.data, img.type) : null;
      if (imgId) {
        db.update('items', j.itemId, { [j.kind]: imgId, updated_at: nowIso() });
        res.images++;
        changed.add(j.itemId);
      }
    } catch (e) {
      res.imageErrors++;
      if (res.imageErrors <= 5) log.warn(`Artwork download failed (${j.kind}): ${(e as Error).message}`);
    } finally {
      done++;
      if (done % 50 === 0) progress(`Downloading artwork (${done} of ${jobs.length})`, 0.4 + (done / Math.max(1, jobs.length)) * 0.6);
    }
  });
  res.updated = changed.size;
  return res;
}
