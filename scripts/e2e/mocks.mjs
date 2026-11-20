import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Local stand-ins for the outside services the journeys touch, all on one port:
 *   /3/…            TMDB (a small fictional "not in your library yet" catalogue for Discover and requests)
 *   /radarr/api/v3  Radarr          /sonarr/api/v3  Sonarr
 *   /hook           JSON webhook receiver (notification agents)
 *   /lb/1/…         ListenBrainz (token validation, listens)
 * Every call is recorded in `calls` so a journey can assert that MediaMax really talked to it.
 *
 * The screenshot pipeline (scripts/screenshots) reuses these with `opts`: TMDB results get poster and backdrop
 * paths served from a local folder (/t/p/<size>/<file>, pointed at by MEDIAMAX_TMDB_IMAGE_BASE), Discover rows come
 * back in different orders, and Radarr/Sonarr report a download queue, upcoming releases and missing titles.
 * `style`, `pal` and `motif` on the catalogue entries are only used to draw that artwork.
 */
export const LB_TOKEN = 'e2e-listenbrainz-token';
export const ARR_KEY = 'e2e-arr-key';

export const DISCOVER_MOVIES = [
  { id: 9001, title: 'The Glass Orchard', release_date: '2025-03-14', overview: 'A botanist inherits an orchard where the fruit is made of glass.', vote_average: 7.8, genre_ids: [18, 14] },
  { id: 9002, title: 'Copper Tide', release_date: '2024-10-02', overview: 'Salvage divers find a city under the harbour.', vote_average: 7.1, genre_ids: [12] },
  { id: 9003, title: 'Ninety Lanterns', release_date: '2025-06-20', overview: 'A village lights one lantern a night until the fog lifts.', vote_average: 6.9, genre_ids: [18] },
  { id: 9004, title: 'Parallel Postcards', release_date: '2023-08-11', overview: 'Postcards arrive from a version of the town that never flooded.', vote_average: 7.4, genre_ids: [878, 18] },
  { id: 9005, title: 'The Salt Road', release_date: '2025-09-05', overview: 'Two rival caravans race across a dried-up sea for the last well.', vote_average: 7.2, genre_ids: [12] },
  { id: 9006, title: 'Static Hearts', release_date: '2024-02-14', overview: 'A radio host falls for a caller who only phones in during thunderstorms.', vote_average: 6.8, genre_ids: [18] },
  { id: 9007, title: 'Moth Season', release_date: '2025-10-31', overview: 'Every autumn the moths return to the old cinema, and so does something else.', vote_average: 6.6, genre_ids: [9648] },
  { id: 9008, title: 'Gravity Garden', release_date: '2024-05-17', overview: 'On a space station, a gardener grows the first tree in orbit.', vote_average: 7.9, genre_ids: [878] },
  { id: 9009, title: 'Paper Lanterns, Paper Boats', release_date: '2023-12-01', overview: 'Two kids build a fleet of paper boats to sail to their grandmother.', vote_average: 7.5, genre_ids: [12, 14] },
  { id: 9010, title: 'The Midnight Ledger', release_date: '2025-01-24', overview: 'An accountant finds a second set of books that predicts the future.', vote_average: 7.0, genre_ids: [9648, 18] },
];
export const DISCOVER_SHOWS = [
  { id: 9501, name: 'Lighthouse Keepers Guild', first_air_date: '2024-01-09', overview: 'Keepers of the last staffed lighthouses swap stories.', vote_average: 8.1, genre_ids: [99] },
  { id: 9502, name: 'Midnight Cartographers', first_air_date: '2025-02-01', overview: 'Mapmakers chart a city that changes every night.', vote_average: 7.6, genre_ids: [9648] },
  { id: 9503, name: 'Harbour Kitchen', first_air_date: '2023-04-12', overview: 'A fishing-town café cooks whatever the boats bring in.', vote_average: 7.3, genre_ids: [99] },
  { id: 9504, name: 'Orbit Street', first_air_date: '2024-09-03', overview: 'Neighbours on the first residential street in orbit.', vote_average: 7.7, genre_ids: [878, 18] },
  { id: 9505, name: 'The Fog Bell', first_air_date: '2025-03-28', overview: 'A coastal village where the fog bell rings for people, not ships.', vote_average: 7.1, genre_ids: [9648] },
];

/** Poster artwork for the screenshot pipeline (ignored by MediaMax): [style, palette, motif]. */
const ART = {
  9001: ['drama', ['#14210f', '#3d5a2a', '#cfe8ff', '#f4f7ee'], 'grove'], 9002: ['adventure', ['#0c2a33', '#1f6f78', '#e3a54a', '#f6e7c1'], null],
  9003: ['drama', ['#1a1424', '#4a3060', '#ffb35c', '#ffe7c4'], null], 9004: ['scifi', ['#0a1022', '#21406b', '#ff8a5c', '#d8f1ff'], 'dish'],
  9005: ['adventure', ['#3a1f0e', '#a0602a', '#ffd38a', '#fff3dc'], null], 9006: ['noir', ['#0d0b12', '#3a2440', '#ff4d6d', '#ffe0e6'], null],
  9007: ['horror', ['#07080c', '#252033', '#c9a7ff', '#efe6ff'], 'chapel'], 9008: ['scifi', ['#03111a', '#0c4a4f', '#7dffb2', '#e6fff2'], 'orbit'],
  9009: ['family', ['#1b3b6f', '#4d8fd6', '#ffcf56', '#fff7e0'], null], 9010: ['noir', ['#0b0d10', '#2b3440', '#e8c170', '#f7f0de'], 'hotel'],
  9501: ['scifi', ['#020c1b', '#0b3a5b', '#7cf7ff', '#ffd27a'], 'lighthouse'], 9502: ['noir', ['#0a0a14', '#28284a', '#5ce1e6', '#e6fbff'], null],
  9503: ['comedy', ['#21405e', '#5fa8d3', '#ffb38a', '#fff4e6'], 'bakery'], 9504: ['scifi', ['#0b0820', '#3a2a7a', '#ff9de2', '#f3e9ff'], 'ship'],
  9505: ['horror', ['#0b1013', '#2e3c43', '#a8d5e2', '#eef8fb'], 'birch'],
};
for (const it of [...DISCOVER_MOVIES, ...DISCOVER_SHOWS]) [it.style, it.pal, it.motif] = ART[it.id];

const GENRES = [{ id: 18, name: 'Drama' }, { id: 12, name: 'Adventure' }, { id: 14, name: 'Fantasy' }, { id: 878, name: 'Science Fiction' }, { id: 99, name: 'Documentary' }, { id: 9648, name: 'Mystery' }];
const pageOf = (results) => ({ page: 1, total_pages: 1, total_results: results.length, results });
const tagged = () => [...DISCOVER_MOVIES.map((m) => ({ ...m, media_type: 'movie' })), ...DISCOVER_SHOWS.map((s) => ({ ...s, media_type: 'tv' }))];

function tmdb(p, q, opts = {}) {
  const art = (it) => (opts.images ? { ...it, poster_path: `/poster-${it.id}.jpg`, backdrop_path: `/backdrop-${it.id}.jpg` } : it);
  const page = (results) => pageOf(results.map(art));
  let m;
  if ((m = p.match(/^\/movie\/(\d+)$/))) {
    const it = DISCOVER_MOVIES.find((x) => x.id === Number(m[1]));
    if (!it) return undefined;
    return { ...art(it), runtime: 104, genres: GENRES.filter((g) => it.genre_ids.includes(g.id)), credits: { cast: [], crew: [] }, images: { posters: [], backdrops: [], logos: [] }, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13', type: 3 }] }] }, videos: { results: [] }, external_ids: { imdb_id: `tt9${m[1]}` } };
  }
  if ((m = p.match(/^\/tv\/(\d+)\/external_ids$/))) return { tvdb_id: Number(m[1]) + 100000 };
  if ((m = p.match(/^\/tv\/(\d+)\/season\/(\d+)$/))) return { season_number: Number(m[2]), episodes: [1, 2, 3].map((n) => ({ episode_number: n, name: `Episode ${n}`, air_date: '2024-01-0' + n })) };
  if ((m = p.match(/^\/tv\/(\d+)$/))) {
    const it = DISCOVER_SHOWS.find((x) => x.id === Number(m[1]));
    if (!it) return undefined;
    return { ...art(it), status: 'Returning Series', number_of_seasons: 2, seasons: [1, 2].map((n) => ({ season_number: n, name: `Season ${n}`, episode_count: 3, air_date: `202${3 + n}-01-01` })), genres: GENRES.filter((g) => it.genre_ids.includes(g.id)), credits: { cast: [], crew: [] }, images: { posters: [], backdrops: [], logos: [] }, content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-PG' }] }, external_ids: { tvdb_id: it.id + 100000 }, videos: { results: [] } };
  }
  if (p === '/genre/movie/list' || p === '/genre/tv/list') return { genres: GENRES };
  if (/^\/(company|network)\/\d+$/.test(p)) return { id: 1, name: 'Fictional Studio' };
  if (/^\/person\/\d+$/.test(p)) return { id: 1, name: 'Nobody', combined_credits: { cast: [], crew: [] } };
  if (p.startsWith('/search/')) {
    const term = (q.get('query') ?? '').toLowerCase();
    const pool = p === '/search/movie' ? DISCOVER_MOVIES : p === '/search/tv' ? DISCOVER_SHOWS : p === '/search/person' ? [] : tagged();
    return page(pool.filter((x) => (x.title ?? x.name).toLowerCase().includes(term)));
  }
  if (p.startsWith('/find/')) return { movie_results: [], tv_results: [] };
  if (/^\/(trending|discover|movie|tv)\//.test(p)) {
    // Showcase: each list (trending, popular, upcoming…) in its own order, so Discover rows don't all look alike.
    const order = (list) => {
      if (!opts.images) return list;
      const k = [...(p + q.toString())].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7);
      return list.map((x, i) => [x, (i * 37 + k) % 101]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    };
    if (p.includes('/tv') || p.startsWith('/tv/')) return page(order(DISCOVER_SHOWS.map((s) => ({ ...s, media_type: 'tv' }))));
    if (p.includes('/movie') || p.startsWith('/movie/')) return page(order(DISCOVER_MOVIES.map((s) => ({ ...s, media_type: 'movie' }))));
    return page(order(tagged()));
  }
  return undefined;
}

const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
const ahead = (d) => new Date(Date.now() + d * 86400000).toISOString();
/** Showcase data for the Downloads dashboard (fictional titles). */
const SHOWCASE_ARR = {
  radarr: {
    queue: () => [
      { id: 1, title: 'Copper.Tide.2024.1080p', movie: { title: 'Copper Tide', year: 2024, tmdbId: 9002 }, size: 8.4e9, sizeleft: 2.9e9, timeleft: '00:12:40', status: 'downloading', trackedDownloadState: 'downloading', protocol: 'torrent', downloadClient: 'qBittorrent', quality: { quality: { name: 'Bluray-1080p' } } },
      { id: 2, title: 'Gravity.Garden.2024.2160p', movie: { title: 'Gravity Garden', year: 2024, tmdbId: 9008 }, size: 21.5e9, sizeleft: 17.2e9, timeleft: '01:48:05', status: 'downloading', trackedDownloadState: 'downloading', protocol: 'usenet', downloadClient: 'SABnzbd', quality: { quality: { name: 'WEBDL-2160p' } } },
      { id: 3, title: 'Parallel.Postcards.2023.1080p', movie: { title: 'Parallel Postcards', year: 2023, tmdbId: 9004 }, size: 6.1e9, sizeleft: 0, timeleft: null, status: 'completed', trackedDownloadState: 'importPending', protocol: 'torrent', downloadClient: 'qBittorrent', quality: { quality: { name: 'WEBDL-1080p' } } },
    ],
    calendar: () => [
      { id: 11, title: 'The Salt Road', year: 2025, digitalRelease: ahead(3), hasFile: false, monitored: true },
      { id: 12, title: 'Moth Season', year: 2025, inCinemas: ahead(8), hasFile: false, monitored: true },
    ],
    missing: () => [{ id: 21, title: 'Ninety Lanterns', year: 2025, studio: 'Fictional Studio', digitalRelease: ago(24 * 20) }],
  },
  sonarr: {
    queue: () => [
      { id: 4, title: 'Midnight.Cartographers.S01E03', series: { title: 'Midnight Cartographers', tvdbId: 109502 }, episode: { seasonNumber: 1, episodeNumber: 3, title: 'The Moving Bridge' }, size: 1.6e9, sizeleft: 0.5e9, timeleft: '00:04:12', status: 'downloading', trackedDownloadState: 'downloading', protocol: 'usenet', downloadClient: 'SABnzbd', quality: { quality: { name: 'WEBDL-1080p' } } },
      { id: 5, title: 'Orbit.Street.S02E01', series: { title: 'Orbit Street', tvdbId: 109504 }, episode: { seasonNumber: 2, episodeNumber: 1, title: 'Moving Day' }, size: 2.2e9, sizeleft: 2.2e9, timeleft: null, status: 'queued', trackedDownloadState: 'downloading', protocol: 'torrent', downloadClient: 'qBittorrent', quality: { quality: { name: 'WEBDL-1080p' } } },
    ],
    calendar: () => [
      { id: 31, series: { title: 'Orbit Street' }, seasonNumber: 2, episodeNumber: 2, title: 'Low Gravity Lunch', airDateUtc: ahead(2), hasFile: false, monitored: true },
      { id: 32, series: { title: 'The Fog Bell' }, seasonNumber: 1, episodeNumber: 5, title: 'Lantern Night', airDateUtc: ahead(5), hasFile: false, monitored: true },
    ],
    missing: () => [{ id: 41, series: { title: 'Harbour Kitchen' }, seasonNumber: 3, episodeNumber: 4, title: 'Storm Supper', airDateUtc: ago(24 * 6) }],
  },
};

function arr(kind, p, method, body, opts = {}) {
  const demo = opts.downloads ? SHOWCASE_ARR[kind] : null;
  const table = {
    'GET /system/status': () => ({ appName: kind === 'radarr' ? 'Radarr' : 'Sonarr', version: '5.14.0' }),
    'GET /qualityprofile': () => [{ id: 1, name: 'HD-1080p' }, { id: 4, name: 'Ultra-HD' }],
    'GET /rootfolder': () => [{ path: `/${kind}`, freeSpace: 5e11 }],
    'GET /tag': () => [{ id: 7, label: 'requests' }],
    'GET /languageprofile': () => [{ id: 2, name: 'English' }],
    'GET /health': () => [],
    'GET /diskspace': () => [{ path: '/data', label: 'data', freeSpace: 2e11, totalSpace: 1e12 }],
    'GET /queue': () => ({ records: demo?.queue() ?? [] }),
    'GET /calendar': () => demo?.calendar() ?? [],
    'GET /wanted/missing': () => ({ records: demo?.missing() ?? [] }),
    'GET /movie': () => [],
    'GET /series': () => [],
    'GET /movie/lookup/tmdb': (q) => ({ title: 'Looked up', tmdbId: Number(q.get('tmdbId')), year: 2025, images: [] }),
    'GET /series/lookup': () => [{ title: 'Looked up', tvdbId: 109501, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] }],
    'POST /movie': () => ({ ...body, id: 50 }),
    'POST /series': () => ({ ...body, id: 51 }),
    'POST /command': () => ({ id: 99, name: body?.name }),
  };
  return table[`${method} ${p}`];
}

/**
 * `opts.images`: folder of poster-<id>.jpg / backdrop-<id>.jpg served at /t/p/<size>/… (adds artwork to TMDB results).
 * `opts.downloads`: Radarr/Sonarr report a queue, calendar and missing titles.
 */
export function startServiceMocks(port = 0, opts = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      calls.push({ method: req.method, path: u.pathname, query: u.search, body, headers: req.headers });
      const json = (o, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (u.pathname.startsWith('/3/')) {
        const out = tmdb(u.pathname.slice(2), u.searchParams, opts);
        return out === undefined ? json({ status_message: 'not found' }, 404) : json(out);
      }
      const am = u.pathname.match(/^\/(radarr|sonarr)\/api\/v3(\/.*)$/);
      if (am) {
        if (req.headers['x-api-key'] !== ARR_KEY && u.searchParams.get('apikey') !== ARR_KEY) return json({ error: 'Unauthorized' }, 401);
        const h = arr(am[1], am[2].replace(/\/$/, ''), req.method, body, opts);
        return h ? json(h(u.searchParams), req.method === 'POST' ? 201 : 200) : json({ message: 'not found' }, 404);
      }
      const img = opts.images && u.pathname.match(/^\/t\/p\/[a-z0-9]+\/((?:poster|backdrop)-\d+\.jpg)$/);
      if (img) {
        const file = path.join(opts.images, img[1]);
        if (!fs.existsSync(file)) return json({ error: 'no image' }, 404);
        return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(fs.readFileSync(file));
      }
      if (u.pathname === '/hook') return json({ ok: true });
      if (u.pathname.startsWith('/lb/1/')) {
        const auth = req.headers.authorization ?? '';
        if (u.pathname === '/lb/1/validate-token') return json(auth === `Token ${LB_TOKEN}` ? { code: 200, valid: true, user_name: 'e2e-listener', message: 'Token valid.' } : { code: 200, valid: false, message: 'Token invalid.' });
        if (auth !== `Token ${LB_TOKEN}`) return json({ code: 401, error: 'Invalid token' }, 401);
        if (u.pathname === '/lb/1/submit-listens') return json({ status: 'ok' });
        return json({ payload: { count: 0, listens: [], recordings: [], mbids: [] } });
      }
      json({ error: 'no mock for ' + u.pathname }, 404);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, calls, server, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}
