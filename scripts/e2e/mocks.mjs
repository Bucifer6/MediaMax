import http from 'node:http';

/**
 * Local stand-ins for the outside services the journeys touch, all on one port:
 *   /3/…            TMDB (a small fictional "not in your library yet" catalogue for Discover and requests)
 *   /radarr/api/v3  Radarr          /sonarr/api/v3  Sonarr
 *   /hook           JSON webhook receiver (notification agents)
 *   /lb/1/…         ListenBrainz (token validation, listens)
 * Every call is recorded in `calls` so a journey can assert that MediaMax really talked to it.
 */
export const LB_TOKEN = 'e2e-listenbrainz-token';
export const ARR_KEY = 'e2e-arr-key';

export const DISCOVER_MOVIES = [
  { id: 9001, title: 'The Glass Orchard', release_date: '2025-03-14', overview: 'A botanist inherits an orchard where the fruit is made of glass.', vote_average: 7.8, genre_ids: [18, 14] },
  { id: 9002, title: 'Copper Tide', release_date: '2024-10-02', overview: 'Salvage divers find a city under the harbour.', vote_average: 7.1, genre_ids: [12] },
  { id: 9003, title: 'Ninety Lanterns', release_date: '2025-06-20', overview: 'A village lights one lantern a night until the fog lifts.', vote_average: 6.9, genre_ids: [18] },
  { id: 9004, title: 'Parallel Postcards', release_date: '2023-08-11', overview: 'Postcards arrive from a version of the town that never flooded.', vote_average: 7.4, genre_ids: [878, 18] },
];
export const DISCOVER_SHOWS = [
  { id: 9501, name: 'Lighthouse Keepers Guild', first_air_date: '2024-01-09', overview: 'Keepers of the last staffed lighthouses swap stories.', vote_average: 8.1, genre_ids: [99] },
  { id: 9502, name: 'Midnight Cartographers', first_air_date: '2025-02-01', overview: 'Mapmakers chart a city that changes every night.', vote_average: 7.6, genre_ids: [9648] },
];

const GENRES = [{ id: 18, name: 'Drama' }, { id: 12, name: 'Adventure' }, { id: 14, name: 'Fantasy' }, { id: 878, name: 'Science Fiction' }, { id: 99, name: 'Documentary' }, { id: 9648, name: 'Mystery' }];
const page = (results) => ({ page: 1, total_pages: 1, total_results: results.length, results });
const tagged = () => [...DISCOVER_MOVIES.map((m) => ({ ...m, media_type: 'movie' })), ...DISCOVER_SHOWS.map((s) => ({ ...s, media_type: 'tv' }))];

function tmdb(p, q) {
  let m;
  if ((m = p.match(/^\/movie\/(\d+)$/))) {
    const it = DISCOVER_MOVIES.find((x) => x.id === Number(m[1]));
    if (!it) return undefined;
    return { ...it, runtime: 104, genres: GENRES.filter((g) => it.genre_ids.includes(g.id)), credits: { cast: [], crew: [] }, images: { posters: [], backdrops: [], logos: [] }, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13', type: 3 }] }] }, videos: { results: [] }, external_ids: { imdb_id: `tt9${m[1]}` } };
  }
  if ((m = p.match(/^\/tv\/(\d+)\/external_ids$/))) return { tvdb_id: Number(m[1]) + 100000 };
  if ((m = p.match(/^\/tv\/(\d+)\/season\/(\d+)$/))) return { season_number: Number(m[2]), episodes: [1, 2, 3].map((n) => ({ episode_number: n, name: `Episode ${n}`, air_date: '2024-01-0' + n })) };
  if ((m = p.match(/^\/tv\/(\d+)$/))) {
    const it = DISCOVER_SHOWS.find((x) => x.id === Number(m[1]));
    if (!it) return undefined;
    return { ...it, status: 'Returning Series', number_of_seasons: 2, seasons: [1, 2].map((n) => ({ season_number: n, name: `Season ${n}`, episode_count: 3, air_date: `202${3 + n}-01-01` })), genres: GENRES.filter((g) => it.genre_ids.includes(g.id)), credits: { cast: [], crew: [] }, images: { posters: [], backdrops: [], logos: [] }, content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-PG' }] }, external_ids: { tvdb_id: it.id + 100000 }, videos: { results: [] } };
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
    if (p.includes('/tv') || p.startsWith('/tv/')) return page(DISCOVER_SHOWS.map((s) => ({ ...s, media_type: 'tv' })));
    if (p.includes('/movie') || p.startsWith('/movie/')) return page(DISCOVER_MOVIES.map((s) => ({ ...s, media_type: 'movie' })));
    return page(tagged());
  }
  return undefined;
}

function arr(kind, p, method, body) {
  const table = {
    'GET /system/status': () => ({ appName: kind === 'radarr' ? 'Radarr' : 'Sonarr', version: '5.14.0' }),
    'GET /qualityprofile': () => [{ id: 1, name: 'HD-1080p' }, { id: 4, name: 'Ultra-HD' }],
    'GET /rootfolder': () => [{ path: `/${kind}`, freeSpace: 5e11 }],
    'GET /tag': () => [{ id: 7, label: 'requests' }],
    'GET /languageprofile': () => [{ id: 2, name: 'English' }],
    'GET /health': () => [],
    'GET /diskspace': () => [{ path: '/data', label: 'data', freeSpace: 2e11, totalSpace: 1e12 }],
    'GET /queue': () => ({ records: [] }),
    'GET /calendar': () => [],
    'GET /wanted/missing': () => ({ records: [] }),
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

export function startServiceMocks(port = 0) {
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
        const out = tmdb(u.pathname.slice(2), u.searchParams);
        return out === undefined ? json({ status_message: 'not found' }, 404) : json(out);
      }
      const am = u.pathname.match(/^\/(radarr|sonarr)\/api\/v3(\/.*)$/);
      if (am) {
        if (req.headers['x-api-key'] !== ARR_KEY && u.searchParams.get('apikey') !== ARR_KEY) return json({ error: 'Unauthorized' }, 401);
        const h = arr(am[1], am[2].replace(/\/$/, ''), req.method, body);
        return h ? json(h(u.searchParams), req.method === 'POST' ? 201 : 200) : json({ message: 'not found' }, 404);
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
