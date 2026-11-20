import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { XMLParser } from 'fast-xml-parser';
import type { PodcastSearchResult, PodcastSubscription } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { config } from '../config.js';
import { newId, stableId } from '../util/ids.js';
import { badRequest, conflict, HttpError, notFound } from '../util/errors.js';
import { nowIso, sortTitle } from '../util/misc.js';
import { registerImage, imageUrl } from './images.js';
import { events, bus } from './events.js';
import { logger } from '../util/log.js';

const log = logger('podcasts');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', isArray: (n) => n === 'item' || n === 'category' || n === 'itunes:category' || n === 'outline' });

const text = (v: any): string | null => {
  if (v == null) return null;
  if (typeof v === 'object') return v['#text'] != null ? String(v['#text']).trim() : null;
  const s = String(v).trim();
  return s || null;
};

/** "01:02:03", "62:03", "3723" → ms */
export function parseDuration(v: unknown): number | null {
  const s = text(v);
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
  const parts = s.split(':').map((x) => parseInt(x, 10));
  if (parts.some((x) => Number.isNaN(x))) return null;
  return parts.reduce((acc, x) => acc * 60 + x, 0) * 1000;
}

const stripHtml = (s: string | null) => (s ? s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim() : null);

export interface ParsedFeed {
  title: string;
  author: string | null;
  description: string | null;
  image: string | null;
  categories: string[];
  episodes: { guid: string; title: string; description: string | null; url: string; type: string | null; size: number | null; pubDate: string | null; durationMs: number | null; image: string | null; season: number | null; episode: number | null }[];
}

export function parseFeed(xml: string): ParsedFeed {
  const doc = parser.parse(xml);
  const ch = doc?.rss?.channel;
  if (!ch) throw badRequest('That URL is not a podcast RSS feed');
  const cats = [...(ch['itunes:category'] ?? []).map((c: any) => c?.['@text']), ...(ch.category ?? []).map(text)].filter(Boolean) as string[];
  return {
    title: text(ch.title) ?? 'Untitled podcast',
    author: text(ch['itunes:author']) ?? text(ch.author) ?? null,
    description: stripHtml(text(ch['itunes:summary']) ?? text(ch.description)),
    image: ch['itunes:image']?.['@href'] ?? text(ch.image?.url) ?? null,
    categories: [...new Set(cats)].slice(0, 5),
    episodes: (ch.item ?? []).filter((i: any) => i.enclosure?.['@url']).map((i: any) => {
      const pub = text(i.pubDate);
      const d = pub ? new Date(pub) : null;
      return {
        guid: text(i.guid) ?? i.enclosure['@url'],
        title: text(i.title) ?? 'Episode',
        description: stripHtml(text(i['content:encoded']) ?? text(i.description) ?? text(i['itunes:summary'])),
        url: i.enclosure['@url'],
        type: i.enclosure['@type'] ?? null,
        size: parseInt(i.enclosure['@length'] ?? '', 10) || null,
        pubDate: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
        durationMs: parseDuration(i['itunes:duration']),
        image: i['itunes:image']?.['@href'] ?? null,
        season: parseInt(text(i['itunes:season']) ?? '', 10) || null,
        episode: parseInt(text(i['itunes:episode']) ?? '', 10) || null,
      };
    }),
  };
}

function ensureLibrary(): string {
  const ex = db.get("SELECT id FROM libraries WHERE type = 'podcasts'");
  if (ex) return ex.id;
  const id = newId();
  const max = db.get<{ m: number | null }>('SELECT MAX(sort_order) m FROM libraries')?.m ?? 0;
  db.insert('libraries', { id, name: 'Podcasts', type: 'podcasts', paths: '[]', fetch_metadata: 0, sort_order: (max ?? 0) + 1, created_at: nowIso() });
  return id;
}

function toSub(r: Row): PodcastSubscription {
  const item = db.get('SELECT title, poster FROM items WHERE id = ?', r.item_id);
  return {
    id: r.id, itemId: r.item_id, feedUrl: r.feed_url, title: item?.title ?? r.feed_url, imageUrl: imageUrl(item?.poster),
    episodeCount: db.get<{ n: number }>('SELECT COUNT(*) n FROM items WHERE parent_id = ?', r.item_id)!.n,
    lastRefreshAt: r.last_refresh_at ?? null, lastError: r.last_error ?? null, autoDownload: !!r.auto_download,
  };
}

export const listSubscriptions = () => db.all('SELECT * FROM podcast_feeds ORDER BY created_at').map(toSub);

const extFor = (url: string, type: string | null) => {
  const e = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  if (['mp3', 'm4a', 'aac', 'ogg', 'opus', 'mp4', 'm4v', 'mov', 'wav', 'flac'].includes(e)) return e;
  if (type?.includes('mpeg')) return 'mp3';
  if (type?.includes('mp4') || type?.includes('m4a')) return 'm4a';
  if (type?.includes('ogg')) return 'ogg';
  return 'mp3';
};

async function fetchFeed(url: string, etag?: string | null): Promise<{ xml: string | null; etag: string | null }> {
  const res = await fetch(url, { headers: { 'User-Agent': `MediaMax/${config.version} (podcast client)`, Accept: 'application/rss+xml, application/xml, text/xml, */*', ...(etag ? { 'If-None-Match': etag } : {}) }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
  if (res.status === 304) return { xml: null, etag: etag ?? null };
  if (!res.ok) throw new HttpError(502, `Feed returned HTTP ${res.status}`, 'feed_error');
  return { xml: await res.text(), etag: res.headers.get('etag') };
}

function syncFeed(feedRow: Row, feed: ParsedFeed): string[] {
  const libId = ensureLibrary();
  const podId = feedRow.item_id;
  const now = nowIso();
  const fresh: string[] = [];
  db.tx(() => {
    const fields = {
      library_id: libId, type: 'podcast', title: feed.title, sort_title: sortTitle(feed.title), overview: feed.description,
      poster: registerImage(feed.image), genres: JSON.stringify(feed.categories), remote_ref: feedRow.feed_url,
      people: JSON.stringify(feed.author ? [{ name: feed.author, role: 'Host', kind: 'producer', imageUrl: null }] : []),
      extra: JSON.stringify({ parentTitle: feed.author }), updated_at: now,
    };
    if (db.get('SELECT 1 FROM items WHERE id = ?', podId)) db.update('items', podId, fields);
    else db.insert('items', { id: podId, ...fields, added_at: now, path: `podcast:${feedRow.feed_url}` });
    for (const ep of feed.episodes) {
      const id = stableId(podId, 'ep', ep.guid);
      const container = extFor(ep.url, ep.type);
      const f = {
        library_id: libId, type: 'podcastepisode', title: ep.title, sort_title: sortTitle(ep.title), overview: ep.description, parent_id: podId,
        release_date: ep.pubDate, year: ep.pubDate ? +ep.pubDate.slice(0, 4) : null, duration_ms: ep.durationMs, idx: ep.episode, parent_idx: ep.season,
        thumb: registerImage(ep.image), remote_ref: ep.guid, updated_at: now,
      };
      if (db.get('SELECT 1 FROM items WHERE id = ?', id)) db.update('items', id, f);
      else {
        db.insert('items', { id, ...f, added_at: ep.pubDate ?? now });
        fresh.push(id);
      }
      const mid = stableId('podmedia', id);
      const m = db.get('SELECT path FROM media WHERE id = ?', mid);
      db.upsert('media', { id: mid, item_id: id, path: m?.path ?? null, remote_url: ep.url, container, size: ep.size, duration_ms: ep.durationMs, probed_at: null });
    }
  });
  return fresh;
}

export async function subscribe(userId: string, feedUrl: string, autoDownload = false): Promise<PodcastSubscription> {
  const url = feedUrl.trim();
  if (!/^https?:\/\//i.test(url)) throw badRequest('Enter the podcast RSS feed URL (http/https)');
  if (db.get('SELECT 1 FROM podcast_feeds WHERE feed_url = ?', url)) throw conflict('You are already subscribed to this podcast');
  const { xml, etag } = await fetchFeed(url);
  const feed = parseFeed(xml ?? '');
  const id = newId();
  const itemId = stableId('podcast', url);
  ensureLibrary();
  const row = { id, item_id: itemId, feed_url: url, auto_download: autoDownload, etag, last_refresh_at: nowIso(), created_by: userId, created_at: nowIso() };
  db.tx(() => {
    // Items first (the feed row references the podcast item).
    syncFeed(row, feed);
    db.insert('podcast_feeds', row);
  });
  events.broadcast({ type: 'library.updated', libraryId: ensureLibrary() });
  if (autoDownload) void downloadNew(id, 3);
  return toSub(db.get('SELECT * FROM podcast_feeds WHERE id = ?', id)!);
}

export function updateSubscription(id: string, patch: { autoDownload?: boolean }): PodcastSubscription {
  const r = db.get('SELECT * FROM podcast_feeds WHERE id = ?', id);
  if (!r) throw notFound('Subscription not found');
  if (patch.autoDownload !== undefined) db.run('UPDATE podcast_feeds SET auto_download = ? WHERE id = ?', patch.autoDownload, id);
  return toSub(db.get('SELECT * FROM podcast_feeds WHERE id = ?', id)!);
}

export function unsubscribe(id: string) {
  const r = db.get('SELECT * FROM podcast_feeds WHERE id = ?', id);
  if (!r) throw notFound('Subscription not found');
  db.run('DELETE FROM items WHERE id = ? OR parent_id = ?', r.item_id, r.item_id);
  db.run('DELETE FROM podcast_feeds WHERE id = ?', id);
  fs.rmSync(path.join(config.dataDir, 'podcasts', id), { recursive: true, force: true });
}

export async function refreshFeed(id: string): Promise<number> {
  const r = db.get('SELECT * FROM podcast_feeds WHERE id = ?', id);
  if (!r) throw notFound('Subscription not found');
  try {
    const { xml, etag } = await fetchFeed(r.feed_url, r.etag);
    let fresh: string[] = [];
    if (xml) fresh = syncFeed(r, parseFeed(xml));
    db.run('UPDATE podcast_feeds SET etag = ?, last_refresh_at = ?, last_error = NULL WHERE id = ?', etag, nowIso(), id);
    if (fresh.length) {
      bus.emit('library.new', { libraryId: ensureLibrary(), itemIds: fresh });
      events.broadcast({ type: 'library.updated', libraryId: ensureLibrary() });
      if (r.auto_download) await downloadNew(id, fresh.length);
    }
    return fresh.length;
  } catch (e) {
    db.run('UPDATE podcast_feeds SET last_error = ?, last_refresh_at = ? WHERE id = ?', (e as Error).message, nowIso(), id);
    throw e;
  }
}

export async function refreshAll(progress?: (p: number) => void): Promise<number> {
  const feeds = db.all<{ id: string }>('SELECT id FROM podcast_feeds');
  let n = 0;
  for (let i = 0; i < feeds.length; i++) {
    try {
      n += await refreshFeed(feeds[i].id);
    } catch (e) {
      log.warn(`Podcast refresh failed: ${(e as Error).message}`);
    }
    progress?.(Math.round(((i + 1) / feeds.length) * 100));
  }
  return n;
}

/** Download the newest `count` episodes that are not on disk yet, so they play offline and survive feed removal. */
export async function downloadNew(feedId: string, count: number) {
  const r = db.get('SELECT * FROM podcast_feeds WHERE id = ?', feedId);
  if (!r) return;
  const dir = path.join(config.dataDir, 'podcasts', feedId);
  fs.mkdirSync(dir, { recursive: true });
  const eps = db.all(`SELECT i.id, m.id mid, m.remote_url, m.container FROM items i JOIN media m ON m.item_id = i.id
    WHERE i.parent_id = ? AND m.path IS NULL ORDER BY COALESCE(i.release_date, i.added_at) DESC LIMIT ?`, r.item_id, count);
  for (const e of eps) {
    const dest = path.join(dir, `${e.id}.${e.container || 'mp3'}`);
    try {
      const res = await fetch(e.remote_url, { headers: { 'User-Agent': `MediaMax/${config.version}` }, signal: AbortSignal.timeout(30 * 60000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest + '.part'));
      fs.renameSync(dest + '.part', dest);
      db.run('UPDATE media SET path = ?, size = ? WHERE id = ?', dest, fs.statSync(dest).size, e.mid);
    } catch (err) {
      fs.rmSync(dest + '.part', { force: true });
      log.warn(`Episode download failed: ${(err as Error).message}`);
    }
  }
}

/** Search the public iTunes podcast directory (no API key needed). */
export async function searchDirectory(term: string): Promise<PodcastSearchResult[]> {
  const q = term.trim();
  if (!q) return [];
  if (/^https?:\/\//i.test(q)) return [{ title: q, author: null, feedUrl: q, imageUrl: null, genre: null }];
  const res = await fetch(`https://itunes.apple.com/search?media=podcast&limit=25&term=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new HttpError(502, 'Podcast directory search failed', 'provider_error');
  const j: any = await res.json();
  return (j.results ?? []).filter((r: any) => r.feedUrl).map((r: any) => ({
    title: r.collectionName ?? r.trackName, author: r.artistName ?? null, feedUrl: r.feedUrl, imageUrl: r.artworkUrl600 ?? r.artworkUrl100 ?? null, genre: r.primaryGenreName ?? null,
  }));
}

bus.on('podcasts.refresh', () => void refreshAll().catch(() => undefined));

/** Import an OPML export from another podcast app. Returns feed URLs found. */
export function parseOpml(xml: string): string[] {
  const urls: string[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes ?? []) {
      if (n['@xmlUrl']) urls.push(n['@xmlUrl']);
      if (n.outline) walk(n.outline);
    }
  };
  const doc = parser.parse(xml);
  walk(doc?.opml?.body?.outline ?? []);
  return [...new Set(urls)];
}
