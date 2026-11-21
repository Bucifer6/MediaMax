/**
 * Subs.ro (Romanian subtitles) REST API.
 *
 *   GET {base}/search/imdbid/{tt…} | /search/tmdbid/{id} | /search/title/{text}   (header X-Subs-Api-Key)
 *   GET {base}/subtitle/{id}/download   → archive (zip, sometimes rar)
 *
 * The response shape was not verifiable from this environment (the API docs were unreachable), so parsing is
 * defensive: the list may be the body itself or under items/results/data/subtitles, and field names have fallbacks.
 * The base URL is configurable (Admin → Server settings → Subtitles) for API version changes and for tests.
 */
import { config } from '../../config.js';
import { getSettings } from '../settings.js';
import { badRequest, HttpError } from '../../util/errors.js';
import type { DownloadedFile, ProviderSubtitle, SubtitleProvider, SubtitleQuery } from './types.js';
import { lang2 } from './lang.js';
import { parseRelease } from './release.js';

export interface SubsRoConfig { apiKey: string | null; baseUrl: string }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function listOf(j: any): any[] {
  if (Array.isArray(j)) return j;
  for (const k of ['items', 'results', 'data', 'subtitles', 'subs']) {
    const v = j?.[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const inner = listOf(v);
      if (inner.length) return inner;
    }
  }
  return [];
}

/** Map one Subs.ro search item to a provider result (null when it has no id). */
export function mapSubsRoItem(x: any): ProviderSubtitle | null {
  const id = str(x?.id ?? x?.subtitleId ?? x?.subtitle_id ?? x?.sid);
  if (!id || !/^[\w-]{1,64}$/.test(id)) return null;
  const title = str(x.title ?? x.name);
  const release = str(x.release ?? x.releases ?? x.description ?? x.comment ?? x.version) ?? title;
  const language = lang2(str(x.language ?? x.lang ?? x.languageCode ?? x.limba) ?? 'ro');
  const fileName = str(x.fileName ?? x.filename ?? x.file);
  const type = (str(x.archiveType ?? x.archive ?? x.type) ?? fileName ?? '').toLowerCase();
  return {
    id, language, release, fileName,
    downloads: num(x.downloads ?? x.downloadCount ?? x.download_count ?? x.hits) ?? 0,
    hearingImpaired: !!(x.hearingImpaired ?? x.hearing_impaired),
    rating: num(x.rating ?? x.rate),
    archive: /\brar\b|\.rar$/.test(type) ? 'rar' : /\bzip\b|\.zip$/.test(type) ? 'zip' : null,
    extra: {
      ...(num(x.season) != null ? { season: num(x.season) } : {}),
      ...(num(x.episode) != null ? { episode: num(x.episode) } : {}),
      ...(title ? { title } : {}),
      ...(str(x.link ?? x.downloadLink ?? x.download_url ?? x.url) ? { link: str(x.link ?? x.downloadLink ?? x.download_url ?? x.url) } : {}),
    },
  };
}

function fileNameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get('content-disposition') ?? '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) ?? cd.match(/filename="?([^";]+)"?/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]).split(/[\\/]/).pop()!;
    } catch {
      return m[1];
    }
  }
  const ct = res.headers.get('content-type') ?? '';
  if (/rar/i.test(ct)) return `${fallback}.rar`;
  if (/zip/i.test(ct)) return `${fallback}.zip`;
  return fallback;
}

export function createSubsRoProvider(cfg: () => SubsRoConfig = () => getSettings().subtitles!.subsRo): SubtitleProvider {
  const headers = (): Record<string, string> => {
    const key = cfg().apiKey;
    if (!key) throw badRequest('Subs.ro is not configured. Add an API key in Admin → Settings → Subtitles.');
    return { 'X-Subs-Api-Key': key, Accept: 'application/json', 'User-Agent': `Kinora v${config.version}` };
  };
  const base = () => (cfg().baseUrl || 'https://api.subs.ro/v1.0').replace(/\/+$/, '');
  const fail = (res: Response, what: string): never => {
    if (res.status === 401 || res.status === 403) throw new HttpError(502, `Subs.ro rejected the API key (HTTP ${res.status})`, 'provider_error');
    if (res.status === 429) throw new HttpError(429, 'Subs.ro request limit reached. Try again later.', 'quota');
    throw new HttpError(502, `Subs.ro ${what} failed (HTTP ${res.status})`, 'provider_error');
  };

  return {
    id: 'subsro',
    name: 'Subs.ro',
    configured: () => !!cfg().apiKey,
    async search(q: SubtitleQuery) {
      // Subs.ro lists series under the show's ids; season packs are common.
      const imdb = q.item.type === 'episode' ? q.showImdbId ?? q.imdbId : q.imdbId;
      const tmdb = q.item.type === 'episode' ? q.showTmdbId ?? q.tmdbId : q.tmdbId;
      const url = imdb && /^tt\d+$/i.test(imdb) ? `${base()}/search/imdbid/${imdb.toLowerCase()}`
        : tmdb && /^\d+$/.test(tmdb) ? `${base()}/search/tmdbid/${tmdb}`
          : `${base()}/search/title/${encodeURIComponent(q.title)}`;
      const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return [];
      if (!res.ok) fail(res, 'search');
      const j: any = await res.json().catch(() => {
        throw new HttpError(502, 'Subs.ro returned an unexpected response', 'provider_error');
      });
      const wanted = new Set(q.languages.map(lang2));
      const out: ProviderSubtitle[] = [];
      for (const raw of listOf(j)) {
        const r = mapSubsRoItem(raw);
        if (!r || (wanted.size && !wanted.has(r.language))) continue;
        if (q.item.type === 'episode' && q.season != null) {
          // Drop other seasons (from the item's own fields or its release text).
          const season = (r.extra?.season as number | undefined) ?? parseRelease(r.release).season;
          if (season != null && season !== q.season) continue;
          const ep = (r.extra?.episode as number | undefined) ?? null;
          if (ep != null && ep !== 0 && q.episode != null && ep !== q.episode) continue;
        }
        out.push(r);
      }
      return out;
    },
    async download(result: ProviderSubtitle): Promise<DownloadedFile> {
      if (!/^[\w-]{1,64}$/.test(result.id)) throw badRequest('Invalid subtitle id');
      const res = await fetch(`${base()}/subtitle/${encodeURIComponent(result.id)}/download`, { headers: { ...headers(), Accept: '*/*' }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
      if (!res.ok) fail(res, 'download');
      // Some API versions answer with JSON carrying a link instead of the file.
      if (/json/i.test(res.headers.get('content-type') ?? '')) {
        const j: any = await res.json();
        const link = str(j?.link ?? j?.url ?? j?.downloadLink ?? j?.data?.link ?? j?.data?.url);
        if (!link || !/^https?:\/\//i.test(link)) throw new HttpError(502, 'Subs.ro download returned no file', 'provider_error');
        const f = await fetch(link, { headers: { 'User-Agent': `Kinora v${config.version}` }, signal: AbortSignal.timeout(30000) });
        if (!f.ok) fail(f, 'download');
        return { data: Buffer.from(await f.arrayBuffer()), fileName: fileNameFrom(f, `subsro-${result.id}`) };
      }
      return { data: Buffer.from(await res.arrayBuffer()), fileName: fileNameFrom(res, `subsro-${result.id}`) };
    },
  };
}

export const subsRoProvider = createSubsRoProvider();
