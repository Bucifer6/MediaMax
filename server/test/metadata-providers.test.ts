// Built-in metadata providers, tested against a local mock of each service. Fixtures follow the shape of each
// API's documented responses (TheTVDB v4, fanart.tv v3, TheAudioDB v1, Audnexus, Open Library, Google Books v1,
// LRCLIB, OMDb, MusicBrainz ws/2 + Cover Art Archive).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.MEDIAMAX_DATA ??= path.join(os.tmpdir(), `mediamax-meta-${process.pid}`);
delete process.env.TMDB_API_KEY;

const { db } = await import('../src/db.ts');
const { updateMetadataSettings, getMetadataSettings, publicMetadataSettings } = await import('../src/services/metadata/config.ts');
const { setProviderHttpOptions, providerFetch, clearCache } = await import('../src/services/metadata/http.ts');
const builtin = await import('../src/services/metadata/builtin.ts');
const { refreshItem, enrichLibrary } = await import('../src/services/metadata/index.ts');
const { fetchLrclib } = await import('../src/services/lyrics.ts');
const { resetTvdbToken } = await import('../src/services/metadata/providers/tvdb.ts');
const { asinFromPath } = await import('../src/services/metadata/providers/audnexus.ts');
const { rowToItem } = await import('../src/services/items.ts');
const { registerImage } = await import('../src/services/images.ts');
const { SECRET_MASK } = await import('../src/services/settings.ts');

/* --------------------------------- fixtures -------------------------------- */

const TVDB_SERIES = {
  status: 'success',
  data: {
    id: 76885, name: 'カウボーイビバップ', slug: 'cowboy-bebop', image: 'https://artworks.thetvdb.com/banners/posters/76885-1.jpg',
    nameTranslations: ['eng', 'jpn'], overviewTranslations: ['eng', 'jpn'], aliases: [], firstAired: '1998-04-03', lastAired: '1999-04-24', nextAired: '',
    score: 152035, status: { id: 2, name: 'Ended' }, originalCountry: 'jpn', originalLanguage: 'jpn', defaultSeasonType: 1, isOrderRandomized: false,
    lastUpdated: '2024-01-01 00:00:00', averageRuntime: 25, overview: '日本語のあらすじ', year: '1998',
    artworks: [
      { id: 1, image: 'https://artworks.thetvdb.com/banners/posters/76885-2.jpg', thumbnail: '', language: 'eng', type: 2, score: 100, width: 680, height: 1000 },
      { id: 2, image: 'https://artworks.thetvdb.com/banners/fanart/original/76885-3.jpg', thumbnail: '', language: null, type: 3, score: 90, width: 1920, height: 1080 },
      { id: 3, image: 'https://artworks.thetvdb.com/banners/v4/series/76885/clearlogo/logo.png', thumbnail: '', language: 'eng', type: 23, score: 80, width: 800, height: 310 },
    ],
    genres: [{ id: 1, name: 'Animation', slug: 'animation' }, { id: 2, name: 'Science Fiction', slug: 'science-fiction' }],
    companies: [{ id: 9, name: 'TV Tokyo', primaryCompanyType: 1, companyType: { companyTypeId: 1, companyTypeName: 'Network' } }],
    remoteIds: [{ id: 'tt0213338', type: 2, sourceName: 'IMDB' }, { id: '30991', type: 12, sourceName: 'TheMovieDB.com' }],
    seasons: [
      { id: 10, seriesId: 76885, type: { id: 1, name: 'Aired Order', type: 'official' }, number: 1, image: 'https://artworks.thetvdb.com/banners/seasons/76885-1.jpg' },
      { id: 11, seriesId: 76885, type: { id: 2, name: 'DVD Order', type: 'dvd' }, number: 1, image: 'https://artworks.thetvdb.com/banners/seasons/dvd.jpg' },
    ],
  },
};
const tvdbEpisode = (id: number, seasonNumber: number, number: number, absoluteNumber: number, name: string) => ({
  id, seriesId: 76885, name, aired: `1998-04-${String(number + 2).padStart(2, '0')}`, runtime: 25, nameTranslations: ['eng'], overview: `${name} overview`,
  overviewTranslations: ['eng'], image: `https://artworks.thetvdb.com/banners/episodes/76885/${id}.jpg`, imageType: 11, isMovie: 0, seasons: [], number,
  absoluteNumber, seasonNumber, lastUpdated: '2024-01-01', finaleType: null, year: '1998',
});
const TVDB_EPISODES: Record<string, any[]> = {
  // TV Tokyo aired the episodes out of order; the DVD order is the intended one.
  default: [tvdbEpisode(1, 1, 1, 2, 'Stray Dog Strut'), tvdbEpisode(2, 1, 2, 3, 'Honky Tonk Women')],
  dvd: [tvdbEpisode(3, 1, 1, 1, 'Asteroid Blues'), tvdbEpisode(4, 1, 2, 2, 'Stray Dog Strut')],
  absolute: [tvdbEpisode(5, 1, 1, 1, 'Asteroid Blues'), tvdbEpisode(6, 1, 2, 2, 'Stray Dog Strut'), tvdbEpisode(7, 1, 3, 3, 'Honky Tonk Women')],
};

const FANART_MOVIE = {
  name: 'The Matrix', tmdb_id: '603', imdb_id: 'tt0133093',
  hdmovielogo: [
    { id: '1', url: 'https://assets.fanart.tv/fanart/movies/603/hdmovielogo/the-matrix-de.png', lang: 'de', likes: '9' },
    { id: '2', url: 'https://assets.fanart.tv/fanart/movies/603/hdmovielogo/the-matrix-en.png', lang: 'en', likes: '4' },
  ],
  movieposter: [{ id: '3', url: 'https://assets.fanart.tv/fanart/movies/603/movieposter/poster.jpg', lang: 'en', likes: '7' }],
  moviebackground: [{ id: '4', url: 'https://assets.fanart.tv/fanart/movies/603/moviebackground/bg.jpg', lang: '', likes: '3' }],
  hdmovieclearart: [{ id: '5', url: 'https://assets.fanart.tv/fanart/movies/603/hdmovieclearart/clearart.png', lang: 'en', likes: '2' }],
  moviedisc: [{ id: '6', url: 'https://assets.fanart.tv/fanart/movies/603/moviedisc/disc.png', lang: 'en', likes: '1', disc: '1', disc_type: 'bluray' }],
};
const FANART_TV = {
  name: 'Cowboy Bebop', thetvdb_id: '76885',
  hdtvlogo: [{ id: '10', url: 'https://assets.fanart.tv/fanart/tv/76885/hdtvlogo/logo.png', lang: 'en', likes: '5' }],
  showbackground: [{ id: '11', url: 'https://assets.fanart.tv/fanart/tv/76885/showbackground/bg.jpg', lang: '', likes: '2', season: 'all' }],
  seasonposter: [
    { id: '12', url: 'https://assets.fanart.tv/fanart/tv/76885/seasonposter/s1.jpg', lang: 'en', likes: '3', season: '1' },
    { id: '13', url: 'https://assets.fanart.tv/fanart/tv/76885/seasonposter/all.jpg', lang: 'en', likes: '9', season: 'all' },
  ],
};
const MBID_COLDPLAY = 'cc197bad-dc9c-440d-a5b5-d52ba2e14234';
const RG_PARACHUTES = '1dc4c347-a1db-32aa-b14f-bc9cc507b843';
const FANART_ARTIST = {
  name: 'Coldplay', mbid_id: MBID_COLDPLAY,
  artistbackground: [{ id: '20', url: 'https://assets.fanart.tv/fanart/music/coldplay/artistbackground/bg.jpg', likes: '4' }],
  hdmusiclogo: [{ id: '21', url: 'https://assets.fanart.tv/fanart/music/coldplay/hdmusiclogo/logo.png', likes: '3' }],
  albums: { [RG_PARACHUTES]: { albumcover: [{ id: '22', url: 'https://assets.fanart.tv/fanart/music/coldplay/albumcover/parachutes.jpg', likes: '2' }] } },
};
const FANART_ALBUM = {
  name: 'Coldplay', mbid_id: MBID_COLDPLAY,
  albums: { [RG_PARACHUTES]: { albumcover: [{ id: '22', url: 'https://assets.fanart.tv/fanart/music/coldplay/albumcover/parachutes.jpg', likes: '2' }], cdart: [{ id: '23', url: 'https://assets.fanart.tv/fanart/music/coldplay/cdart/parachutes.png', likes: '1', disc: '1', size: '1000' }] } },
};

const AUDIODB_ARTIST = {
  artists: [{
    idArtist: '111239', strArtist: 'Coldplay', strArtistAlternate: '', intFormedYear: '1996', intBornYear: '1996', strStyle: 'Rock/Pop', strGenre: 'Alternative Rock',
    strMood: 'Happy', strBiographyEN: 'Coldplay are a British rock band formed in London in 1996.', strBiographyDE: null, strCountry: 'London, England', strCountryCode: 'UK',
    strArtistThumb: 'https://www.theaudiodb.com/images/media/artist/thumb/coldplay.jpg', strArtistLogo: 'https://www.theaudiodb.com/images/media/artist/logo/coldplay.png',
    strArtistFanart: 'https://www.theaudiodb.com/images/media/artist/fanart/coldplay1.jpg', strArtistFanart2: null, strArtistBanner: null, strArtistClearart: null,
    strMusicBrainzID: MBID_COLDPLAY,
  }],
};
const AUDIODB_ALBUM = {
  album: [{
    idAlbum: '2109614', idArtist: '111239', strAlbum: 'Parachutes', strArtist: 'Coldplay', intYearReleased: '2000', strStyle: 'Rock/Pop', strGenre: 'Alternative Rock',
    strMood: 'Sad', strDescriptionEN: 'Parachutes is the debut studio album by Coldplay.', strAlbumThumb: 'https://www.theaudiodb.com/images/media/album/thumb/parachutes.jpg',
    strAlbumCDart: 'https://www.theaudiodb.com/images/media/album/cdart/parachutes.png', strMusicBrainzID: RG_PARACHUTES,
  }],
};

const AUDNEXUS_BOOK = {
  asin: 'B08G9PRS1K', authors: [{ asin: 'B00G0WYW92', name: 'Andy Weir' }],
  description: 'Ryland Grace is the sole survivor on a desperate, last-chance mission.', formatType: 'unabridged',
  genres: [{ asin: '18580606011', name: 'Science Fiction & Fantasy', type: 'genre' }, { asin: '18580628011', name: 'Science Fiction', type: 'tag' }],
  image: 'https://m.media-amazon.com/images/I/91vS2L5YfEL.jpg', isAdult: false, isbn: '9781603935470', language: 'english', literatureType: 'fiction',
  narrators: [{ name: 'Ray Porter' }], publisherName: 'Audible Studios', rating: '4.9', region: 'us', releaseDate: '2021-05-04T00:00:00.000Z', runtimeLengthMin: 970,
  seriesPrimary: { asin: 'B0B5Z8GPF2', name: 'Hail Mary', position: '1' },
  summary: '<p><b>Ryland Grace</b> is the sole survivor on a desperate, last-chance mission&nbsp;- and if he fails, humanity and the earth itself will perish.</p>',
  title: 'Project Hail Mary',
};
const AUDNEXUS_CHAPTERS = {
  asin: 'B08G9PRS1K', brandIntroDurationMs: 2043, brandOutroDurationMs: 5062, isAccurate: true, runtimeLengthMs: 58200000, runtimeLengthSec: 58200,
  chapters: [
    { lengthMs: 30000, startOffsetMs: 0, startOffsetSec: 0, title: 'Opening Credits' },
    { lengthMs: 1500000, startOffsetMs: 30000, startOffsetSec: 30, title: 'Chapter 1' },
  ],
};

const OL_SEARCH = {
  numFound: 1, start: 0, numFoundExact: true,
  docs: [{ key: '/works/OL27448W', title: 'The Hobbit', author_name: ['J.R.R. Tolkien'], first_publish_year: 1937, isbn: ['0261103342', '9780261103344'], cover_i: 14627509, edition_count: 500, subject: ['Fantasy', 'Fiction', 'Dragons', 'Accessible book'] }],
};
const OL_WORK = {
  key: '/works/OL27448W', title: 'The Hobbit', covers: [14627509], subjects: ['Fantasy'],
  description: { type: '/type/text', value: 'Bilbo Baggins is a hobbit who enjoys a comfortable life.' },
};
const GB_SEARCH = {
  kind: 'books#volumes', totalItems: 1,
  items: [{
    kind: 'books#volume', id: 'pD6arNyKyi8C', etag: 'x', selfLink: 'https://www.googleapis.com/books/v1/volumes/pD6arNyKyi8C',
    volumeInfo: {
      title: 'The Hobbit', authors: ['J.R.R. Tolkien'], publisher: 'HarperCollins UK', publishedDate: '2009-04-20',
      description: '<p>A great modern classic and the prelude to <i>The Lord of the Rings</i>.</p>',
      industryIdentifiers: [{ type: 'ISBN_10', identifier: '0007322607' }, { type: 'ISBN_13', identifier: '9780007322602' }],
      categories: ['Fiction / Fantasy / Classic'], averageRating: 4.5,
      imageLinks: { smallThumbnail: 'http://books.google.com/books/content?id=pD6arNyKyi8C&printsec=frontcover&img=1&zoom=5&edge=curl&source=gbs_api', thumbnail: 'http://books.google.com/books/content?id=pD6arNyKyi8C&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api' },
      language: 'en',
    },
  }],
};
const LRCLIB_HIT = {
  id: 3396226, trackName: 'I Want to Live', artistName: 'Borislav Slavov', albumName: "Baldur's Gate 3 (Original Game Soundtrack)", duration: 233, instrumental: false,
  plainLyrics: 'I feel your breath upon my neck\nA soft caress as cold as death',
  syncedLyrics: '[00:17.12] I feel your breath upon my neck\n[00:20.41] A soft caress as cold as death\n',
};
const OMDB_MATRIX = {
  Title: 'The Matrix', Year: '1999', Rated: 'R', Released: '31 Mar 1999', Runtime: '136 min', Genre: 'Action, Sci-Fi', Director: 'Lana Wachowski, Lilly Wachowski',
  Plot: 'When a beautiful stranger leads computer hacker Neo to a forbidding underworld, he discovers the shocking truth.', Language: 'English', Country: 'United States, Australia',
  Poster: 'https://m.media-amazon.com/images/M/MV5BNzQzOTk3OTAtNDQ0Zi00ZTVkLWI0MTEtMDllZjNkYzNjNTc4L2ltYWdlXkEyXkFqcGdeQXVyNjU0OTQ0OTY@._V1_SX300.jpg',
  Ratings: [{ Source: 'Internet Movie Database', Value: '8.7/10' }, { Source: 'Rotten Tomatoes', Value: '83%' }, { Source: 'Metacritic', Value: '73/100' }],
  Metascore: '73', imdbRating: '8.7', imdbVotes: '2,000,000', imdbID: 'tt0133093', Type: 'movie', DVD: 'N/A', BoxOffice: '$172,076,928', Production: 'N/A', Website: 'N/A', Response: 'True',
};
const MBID_RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const RG_OKC = 'b1392450-e666-3926-a536-22c65f834433';
const MB_ARTIST_SEARCH = {
  created: '2024-01-01T00:00:00.000Z', count: 1, offset: 0,
  artists: [{ id: MBID_RADIOHEAD, type: 'Group', score: 100, name: 'Radiohead', 'sort-name': 'Radiohead', country: 'GB', area: { id: 'x', type: 'Country', name: 'United Kingdom' }, 'life-span': { begin: '1991', ended: null } }],
};
const MB_ARTIST = {
  id: MBID_RADIOHEAD, name: 'Radiohead', type: 'Group', disambiguation: '', area: { name: 'United Kingdom' }, 'life-span': { begin: '1991', end: null, ended: false },
  genres: [{ name: 'alternative rock', count: 25 }, { name: 'art rock', count: 18 }], tags: [{ name: 'alternative rock', count: 30 }, { name: 'british', count: 10 }],
};
const MB_RG_SEARCH = {
  created: '2024-01-01T00:00:00.000Z', count: 1, offset: 0,
  'release-groups': [{ id: RG_OKC, score: 100, title: 'OK Computer', 'primary-type': 'Album', 'first-release-date': '1997-05-21', 'artist-credit': [{ name: 'Radiohead', artist: { id: MBID_RADIOHEAD, name: 'Radiohead' } }] }],
};
const MB_RG = { id: RG_OKC, title: 'OK Computer', 'first-release-date': '1997-05-21', 'primary-type': 'Album', genres: [{ name: 'art rock', count: 12 }], tags: [] };

/* -------------------------------- mock server ------------------------------ */

const hits: { path: string; at: number; auth?: string; body?: any }[] = [];
let tvdbToken = 'tok-1';
let server: http.Server;
let base = '';

function route(req: http.IncomingMessage, body: string): { status: number; json?: unknown; headers?: Record<string, string> } {
  const u = new URL(req.url!, 'http://x');
  const p = u.pathname;
  const q = u.searchParams;
  const auth = req.headers.authorization;
  /* TheTVDB v4 */
  if (p === '/tvdb/v4/login' && req.method === 'POST') {
    const b = JSON.parse(body || '{}');
    if (b.apikey !== 'tvdb-key') return { status: 401, json: { status: 'failure', message: 'Unauthorized', data: null } };
    return { status: 200, json: { status: 'success', data: { token: tvdbToken } } };
  }
  if (p.startsWith('/tvdb/v4/')) {
    if (auth !== `Bearer ${tvdbToken}`) return { status: 401, json: { status: 'failure', message: 'Unauthorized' } };
    if (p === '/tvdb/v4/search') return { status: 200, json: { status: 'success', data: [{ objectID: 'series-76885', id: 'series-76885', tvdb_id: '76885', name: 'カウボーイビバップ', year: '1998', image_url: 'https://artworks.thetvdb.com/banners/posters/76885-1.jpg', overview: 'x', overviews: { eng: 'In 2071…' }, translations: { eng: 'Cowboy Bebop' }, network: 'TV Tokyo', country: 'jpn', type: 'series' }], links: {} } };
    if (p === '/tvdb/v4/series/76885/extended') return { status: 200, json: TVDB_SERIES };
    if (p === '/tvdb/v4/series/76885/translations/eng') return { status: 200, json: { status: 'success', data: { name: 'Cowboy Bebop', overview: 'In the year 2071, bounty hunters…', language: 'eng' } } };
    const m = p.match(/^\/tvdb\/v4\/series\/76885\/episodes\/(default|dvd|absolute)\/eng$/);
    if (m) return { status: 200, json: { status: 'success', data: { series: { id: 76885 }, episodes: TVDB_EPISODES[m[1]] }, links: { prev: null, self: req.url, next: null, total_items: TVDB_EPISODES[m[1]].length, page_size: 500 } } };
    return { status: 404, json: { status: 'failure', message: 'NotFound' } };
  }
  /* fanart.tv v3 */
  if (p.startsWith('/fanart/v3/')) {
    if (q.get('api_key') !== 'fan-key') return { status: 401, json: { status: 'error', 'error message': 'Not authorized' } };
    if (p === '/fanart/v3/movies/603') return { status: 200, json: FANART_MOVIE };
    if (p === '/fanart/v3/tv/76885') return { status: 200, json: FANART_TV };
    if (p === `/fanart/v3/music/${MBID_COLDPLAY}`) return { status: 200, json: FANART_ARTIST };
    if (p === `/fanart/v3/music/albums/${RG_PARACHUTES}`) return { status: 200, json: FANART_ALBUM };
    return { status: 404, json: { status: 'error', 'error message': 'Not found' } };
  }
  /* TheAudioDB v1 */
  if (p.startsWith('/audiodb/api/v1/json/2/')) {
    const f = p.slice('/audiodb/api/v1/json/2/'.length);
    if (f === 'search.php') return { status: 200, json: q.get('s')?.toLowerCase() === 'coldplay' ? AUDIODB_ARTIST : { artists: null } };
    if (f === 'artist-mb.php') return { status: 200, json: q.get('i') === MBID_COLDPLAY ? AUDIODB_ARTIST : { artists: null } };
    if (f === 'searchalbum.php') return { status: 200, json: q.get('a') === 'Parachutes' ? AUDIODB_ALBUM : { album: null } };
    if (f === 'album-mb.php') return { status: 200, json: q.get('i') === RG_PARACHUTES ? AUDIODB_ALBUM : { album: null } };
  }
  /* Audnexus */
  if (p === '/audnexus/books/B08G9PRS1K') return { status: 200, json: AUDNEXUS_BOOK };
  if (p === '/audnexus/books/B08G9PRS1K/chapters') return { status: 200, json: AUDNEXUS_CHAPTERS };
  if (p.startsWith('/audnexus/books/')) return { status: 404, json: { statusCode: 404, error: 'Not Found', message: 'Book not found' } };
  /* Open Library */
  if (p === '/ol/search.json') return { status: 200, json: /hobbit/i.test(q.get('title') ?? '') ? OL_SEARCH : { numFound: 0, start: 0, docs: [] } };
  if (p === '/ol/works/OL27448W.json') return { status: 200, json: OL_WORK };
  /* Google Books */
  if (p === '/gb/books/v1/volumes') return { status: 200, json: /hobbit/i.test(q.get('q') ?? '') ? GB_SEARCH : { kind: 'books#volumes', totalItems: 0 } };
  if (p === '/gb/books/v1/volumes/pD6arNyKyi8C') return { status: 200, json: GB_SEARCH.items[0] };
  /* LRCLIB */
  if (p === '/lrclib/api/get') {
    if (q.get('track_name') === 'I Want to Live' && q.get('artist_name') === 'Borislav Slavov') return { status: 200, json: LRCLIB_HIT };
    return { status: 404, json: { code: 404, name: 'TrackNotFound', message: 'Failed to find specified track' } };
  }
  /* OMDb */
  if (p === '/omdb/' || p === '/omdb') {
    if (q.get('apikey') !== 'omdb-key') return { status: 401, json: { Response: 'False', Error: 'Invalid API key!' } };
    if (q.get('i') === 'tt0133093' || (q.get('t') === 'The Matrix' && q.get('type') === 'movie')) return { status: 200, json: OMDB_MATRIX };
    return { status: 200, json: { Response: 'False', Error: 'Movie not found!' } };
  }
  /* MusicBrainz ws/2 + Cover Art Archive */
  if (p === '/mb/ws/2/artist') return { status: 200, json: /radiohead/i.test(q.get('query') ?? '') ? MB_ARTIST_SEARCH : { artists: [] } };
  if (p === `/mb/ws/2/artist/${MBID_RADIOHEAD}`) return { status: 200, json: MB_ARTIST };
  if (p === '/mb/ws/2/release-group') return { status: 200, json: /ok computer/i.test(q.get('query') ?? '') ? MB_RG_SEARCH : { 'release-groups': [] } };
  if (p === `/mb/ws/2/release-group/${RG_OKC}`) return { status: 200, json: MB_RG };
  if (p === `/caa/release-group/${RG_OKC}/front-500`) return { status: 307, headers: { Location: 'https://archive.org/download/mbid-x/mbid-x-123_thumb500.jpg' } };
  if (p.startsWith('/caa/')) return { status: 404, json: null };
  return { status: 404, json: { error: 'no route' } };
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ path: req.url!, at: Date.now(), auth: req.headers.authorization, body: body || undefined });
      assert.match(String(req.headers['user-agent']), /^MediaMax\//, 'every provider request carries the MediaMax User-Agent');
      const r = route(req, body);
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.json === undefined ? '' : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bases: Record<string, string> = {
    tvdb: '/tvdb/v4', fanart: '/fanart/v3', audiodb: '/audiodb/api/v1/json', audnexus: '/audnexus', openlibrary: '/ol', openlibraryCovers: '/olc',
    googlebooks: '/gb/books/v1', lrclib: '/lrclib/api', omdb: '/omdb', musicbrainz: '/mb/ws/2', coverart: '/caa',
  };
  // No client-side delay in tests, except MusicBrainz whose 1 request/second limit is under test.
  for (const [id, p] of Object.entries(bases)) setProviderHttpOptions(id, { base: base + p, ...(id === 'musicbrainz' ? {} : { minIntervalMs: 0 }) });
  updateMetadataSettings({
    providers: {
      tvdb: { enabled: true, apiKey: 'tvdb-key', pin: null }, fanart: { enabled: true, apiKey: 'fan-key' }, audiodb: { enabled: true, apiKey: '2' },
      audnexus: { enabled: true, apiKey: null }, openlibrary: { enabled: true, apiKey: null }, googlebooks: { enabled: true, apiKey: null },
      lrclib: { enabled: true, apiKey: null }, omdb: { enabled: true, apiKey: 'omdb-key' }, musicbrainz: { enabled: true, apiKey: null },
    },
  });
  db.insert('libraries', { id: 'lib-mov', name: 'Movies', type: 'movies', paths: '[]', created_at: new Date().toISOString() });
  db.insert('libraries', { id: 'lib-tv', name: 'TV', type: 'shows', paths: '[]', created_at: new Date().toISOString() });
  db.insert('libraries', { id: 'lib-mus', name: 'Music', type: 'music', paths: '[]', created_at: new Date().toISOString() });
  db.insert('libraries', { id: 'lib-ab', name: 'Books', type: 'audiobooks', paths: '[]', created_at: new Date().toISOString() });
});

after(() => server?.close());

function item(fields: Record<string, unknown>) {
  const now = new Date().toISOString();
  db.insert('items', { sort_title: String(fields.title).toLowerCase(), added_at: now, updated_at: now, ...fields });
  return fields.id as string;
}
const row = (id: string) => db.get('SELECT * FROM items WHERE id = ?', id)!;
const imgSource = (imgId: string | null) => (imgId ? db.get<{ source: string }>('SELECT source FROM images WHERE id = ?', imgId)?.source ?? null : null);
const hitsFor = (prefix: string) => hits.filter((h) => h.path.startsWith(prefix));

/* ----------------------------------- tests --------------------------------- */

test('settings: keys are write-only, the mask keeps the stored key, order is normalised', () => {
  const pub = publicMetadataSettings();
  assert.equal(pub.providers.tvdb.apiKey, SECRET_MASK);
  assert.equal(pub.providers.tvdb.pin, null);
  assert.equal(pub.providers.audnexus.apiKey, null);
  updateMetadataSettings({ providers: { ...pub.providers, tvdb: { enabled: true, apiKey: SECRET_MASK, pin: SECRET_MASK } }, order: ['omdb', 'bogus' as any, 'tmdb'] });
  const s = getMetadataSettings();
  assert.equal(s.providers.tvdb.apiKey, 'tvdb-key', 'mask round-trip keeps the key');
  assert.equal(s.providers.fanart.apiKey, 'fan-key');
  assert.deepEqual(s.order.slice(0, 2), ['omdb', 'tmdb']);
  assert.equal(new Set(s.order).size, 10, 'all providers stay in the order list');
  // Restore the default order for the rest of the tests.
  updateMetadataSettings({ order: ['tmdb', 'tvdb', 'musicbrainz', 'audnexus', 'omdb', 'fanart', 'audiodb', 'googlebooks', 'openlibrary', 'lrclib'] });
  const st = builtin.metadataAdminState();
  assert.equal(st.settings.providers.omdb.apiKey, SECRET_MASK);
  assert.ok(st.providers.find((p) => p.id === 'tmdb'));
  assert.equal(JSON.stringify(st).includes('omdb-key'), false, 'no key leaks into the admin response');
});

test('TheTVDB: login once, English translation over the original language, DVD ordering re-matches episodes', async () => {
  resetTvdbToken();
  const show = item({ id: 'show-cb', library_id: 'lib-tv', type: 'show', title: 'Cowboy Bebop', year: 1998, extra: JSON.stringify({ episodeOrder: 'dvd' }) });
  item({ id: 'season-cb1', library_id: 'lib-tv', type: 'season', title: 'Season 1', idx: 1, parent_id: show });
  item({ id: 'ep-cb1', library_id: 'lib-tv', type: 'episode', title: 'Episode 1', idx: 1, parent_idx: 1, parent_id: 'season-cb1', grandparent_id: show });
  item({ id: 'ep-cb2', library_id: 'lib-tv', type: 'episode', title: 'Episode 2', idx: 2, parent_idx: 1, parent_id: 'season-cb1', grandparent_id: show, locked_fields: '["title"]' });
  await builtin.applyBuiltinProviders(show, { only: ['tvdb'] });
  const r = row(show);
  assert.equal(r.overview, 'In the year 2071, bounty hunters…');
  assert.deepEqual(JSON.parse(r.genres), ['Animation', 'Science Fiction']);
  assert.deepEqual(JSON.parse(r.studios), ['TV Tokyo']);
  assert.equal(r.year, 1998);
  assert.equal(r.title, 'Cowboy Bebop', 'fill-only: the title is not replaced');
  const ids = JSON.parse(r.external_ids);
  assert.equal(ids.tvdb, '76885');
  assert.equal(ids.imdb, 'tt0213338');
  assert.equal(imgSource(r.poster), 'https://artworks.thetvdb.com/banners/posters/76885-2.jpg');
  assert.equal(imgSource(r.logo), 'https://artworks.thetvdb.com/banners/v4/series/76885/clearlogo/logo.png');
  assert.equal(imgSource(row('season-cb1').poster), 'https://artworks.thetvdb.com/banners/seasons/76885-1.jpg', 'season poster from the official order');
  assert.equal(row('ep-cb1').title, 'Asteroid Blues', 'DVD order: episode 1 is Asteroid Blues');
  assert.equal(row('ep-cb2').title, 'Episode 2', 'locked titles stay');
  assert.equal(row('ep-cb2').overview, 'Stray Dog Strut overview');
  assert.ok(row('ep-cb1').metadata_fetched_at);
  assert.equal(hitsFor('/tvdb/v4/login').length, 1);
  assert.ok(hitsFor('/tvdb/v4/series/76885/episodes/dvd/eng').length === 1);
  assert.ok(hitsFor('/tvdb/v4/series/').every((h) => h.auth === 'Bearer tok-1'));

  // Switching to absolute order re-matches against absolute numbers; an expired token triggers one re-login.
  db.run("UPDATE items SET extra = ? WHERE id = ?", JSON.stringify({ episodeOrder: 'absolute' }), show);
  db.run("UPDATE items SET locked_fields = '[]' WHERE id = 'ep-cb2'");
  tvdbToken = 'tok-2';
  await refreshItem('ep-cb1');
  assert.equal(row('ep-cb2').title, 'Stray Dog Strut');
  assert.equal(hitsFor('/tvdb/v4/login').length, 2);
  assert.equal(rowToItem(row(show)).episodeOrder, 'absolute');
});

test('fanart.tv: fills empty art, honours the preferred artwork source, never replaces local art', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-art-'));
  const localPoster = path.join(tmp, 'poster.jpg');
  fs.writeFileSync(localPoster, 'x');
  const movie = item({ id: 'mov-matrix', library_id: 'lib-mov', type: 'movie', title: 'The Matrix', year: 1999, external_ids: '{"tmdb":"603"}', backdrop: registerImage('https://image.tmdb.org/t/p/w1280/old.jpg'), poster: registerImage(localPoster) });
  await builtin.applyBuiltinProviders(movie, { only: ['fanart'] });
  let r = row(movie);
  assert.equal(imgSource(r.logo), FANART_MOVIE.hdmovielogo[1].url, 'English logo preferred over the more-liked German one');
  assert.equal(imgSource(r.backdrop), 'https://image.tmdb.org/t/p/w1280/old.jpg', 'existing art kept when fanart.tv is not the preferred source');
  assert.equal(imgSource(r.poster), localPoster);
  const extra = JSON.parse(r.provider_meta).art;
  assert.equal(imgSource(extra.clearart), FANART_MOVIE.hdmovieclearart[0].url);
  assert.equal(imgSource(extra.discart), FANART_MOVIE.moviedisc[0].url);

  updateMetadataSettings({ artwork: { ...getMetadataSettings().artwork, movie: 'fanart' } });
  await builtin.applyBuiltinProviders(movie, { only: ['fanart'] });
  r = row(movie);
  assert.equal(imgSource(r.backdrop), FANART_MOVIE.moviebackground[0].url, 'preferred source replaces remote art');
  assert.equal(imgSource(r.poster), localPoster, 'local art is never replaced');
  updateMetadataSettings({ artwork: { ...getMetadataSettings().artwork, movie: 'auto' } });

  // Shows by TVDB id (season posters), artists/albums by MusicBrainz id.
  await builtin.applyBuiltinProviders('show-cb', { only: ['fanart'] });
  const artist = item({ id: 'art-coldplay', library_id: 'lib-mus', type: 'artist', title: 'Coldplay', external_ids: JSON.stringify({ musicbrainzArtist: MBID_COLDPLAY }) });
  const album = item({ id: 'alb-parachutes', library_id: 'lib-mus', type: 'album', title: 'Parachutes', parent_id: artist, external_ids: JSON.stringify({ musicbrainzReleaseGroup: RG_PARACHUTES }) });
  await builtin.applyBuiltinProviders(artist, { only: ['fanart'] });
  await builtin.applyBuiltinProviders(album, { only: ['fanart'] });
  assert.equal(imgSource(row(artist).backdrop), FANART_ARTIST.artistbackground[0].url);
  assert.equal(imgSource(row(artist).logo), FANART_ARTIST.hdmusiclogo[0].url);
  assert.equal(imgSource(row(album).poster), FANART_ALBUM.albums[RG_PARACHUTES].albumcover[0].url);
  assert.equal(imgSource(JSON.parse(row(album).provider_meta).art.discart), FANART_ALBUM.albums[RG_PARACHUTES].cdart[0].url);
});

test('TheAudioDB: artist biography, genre, mood, style, formed year and country; album description', async () => {
  const artist = item({ id: 'art-coldplay2', library_id: 'lib-mus', type: 'artist', title: 'Coldplay' });
  const album = item({ id: 'alb-parachutes2', library_id: 'lib-mus', type: 'album', title: 'Parachutes', parent_id: artist, genres: '["Rock"]' });
  await builtin.applyBuiltinProviders(artist, { only: ['audiodb'] });
  await builtin.applyBuiltinProviders(album, { only: ['audiodb'] });
  const a = row(artist);
  assert.match(a.overview, /British rock band/);
  assert.deepEqual(JSON.parse(a.genres), ['Alternative Rock']);
  assert.equal(JSON.parse(a.external_ids).musicbrainzArtist, MBID_COLDPLAY);
  assert.deepEqual(JSON.parse(a.provider_meta).artistInfo, { formedYear: 1996, country: 'London, England', mood: 'Happy', style: 'Rock/Pop' });
  assert.equal(imgSource(a.poster), AUDIODB_ARTIST.artists[0].strArtistThumb);
  const b = row(album);
  assert.match(b.overview, /debut studio album/);
  assert.deepEqual(JSON.parse(b.genres), ['Rock'], 'existing genres are kept (fill-only)');
  assert.equal(b.year, 2000);
  assert.ok(b.metadata_fetched_at, 'provider-filled music is protected from the next scan');
  assert.ok(hitsFor('/audiodb/api/v1/json/2/searchalbum.php?s=Coldplay&a=Parachutes').length >= 1);
});

test('Audnexus: ASIN from the folder name, chapters, series, narrators; Fix match by ASIN', async () => {
  assert.equal(asinFromPath('/books/Andy Weir/Project Hail Mary [B08G9PRS1K]'), 'B08G9PRS1K');
  assert.equal(asinFromPath('/books/B08G9PRS1K - Project Hail Mary.m4b'), 'B08G9PRS1K');
  assert.equal(asinFromPath('/books/Andy Weir/Project Hail Mary'), null);
  const book = item({
    id: 'ab-phm', library_id: 'lib-ab', type: 'audiobook', title: 'Project Hail Mary', path: '/books/Andy Weir/Project Hail Mary [B08G9PRS1K]',
    genres: '["Audiobook"]', people: JSON.stringify([{ name: 'Andy Weir', role: 'Author', kind: 'writer' }]), extra: JSON.stringify({ author: 'Andy Weir', parentTitle: 'Andy Weir' }),
  });
  await builtin.applyBuiltinProviders(book, { only: ['audnexus'] });
  const r = row(book);
  assert.match(r.overview, /^Ryland Grace is the sole survivor/);
  assert.ok(!r.overview.includes('<b>') && !r.overview.includes('&nbsp;'), 'HTML stripped');
  assert.deepEqual(JSON.parse(r.genres), ['Science Fiction & Fantasy'], 'placeholder "Audiobook" genre is replaced, tags ignored');
  assert.equal(r.year, 2021);
  assert.deepEqual(JSON.parse(r.studios), ['Audible Studios']);
  const people = JSON.parse(r.people);
  assert.deepEqual(people.map((p: any) => `${p.name}/${p.role}`), ['Andy Weir/Author', 'Ray Porter/Narrator']);
  assert.equal(JSON.parse(r.external_ids).asin, 'B08G9PRS1K');
  const meta = JSON.parse(r.provider_meta);
  assert.deepEqual(meta.series, { name: 'Hail Mary', index: 1 });
  assert.deepEqual(meta.chapters[1], { title: 'Chapter 1', startMs: 30000, endMs: 1530000 });
  assert.equal(imgSource(r.poster), AUDNEXUS_BOOK.image);
  assert.deepEqual(rowToItem(r).series, { name: 'Hail Mary', index: 1 }, 'series shown when the scan found none');

  const s = await builtin.searchMatch(book, { provider: 'audnexus', query: 'b08g9prs1k' });
  assert.ok(s.providers.includes('audnexus') && s.providers.includes('googlebooks'));
  assert.equal(s.results[0].id, 'B08G9PRS1K');
  assert.match(s.results[0].subtitle!, /Andy Weir · Hail Mary #1/);
  const none = await builtin.searchMatch(book, { provider: 'audnexus', query: 'Project Hail Mary' });
  assert.equal(none.results.length, 0, 'Audnexus has no title search: non-ASIN queries return nothing');
});

test('Open Library and Google Books: audiobook fallbacks by title + author', async () => {
  const people = JSON.stringify([{ name: 'J.R.R. Tolkien', role: 'Author', kind: 'writer' }]);
  const a = item({ id: 'ab-hobbit-ol', library_id: 'lib-ab', type: 'audiobook', title: 'The Hobbit (Unabridged)', genres: '["Audiobook"]', people, extra: JSON.stringify({ author: 'J.R.R. Tolkien' }) });
  await builtin.applyBuiltinProviders(a, { only: ['openlibrary'] });
  let r = row(a);
  assert.equal(r.overview, 'Bilbo Baggins is a hobbit who enjoys a comfortable life.');
  assert.equal(r.year, 1937);
  assert.deepEqual(JSON.parse(r.genres), ['Fantasy', 'Dragons'], 'generic subjects filtered out');
  assert.equal(imgSource(r.poster), `${base}/olc/b/id/14627509-L.jpg`);
  assert.equal(JSON.parse(r.external_ids).isbn, '9780261103344');
  assert.equal(JSON.parse(r.external_ids).openLibrary, 'OL27448W');
  const olq = new URL(base + hitsFor('/ol/search.json').at(-1)!.path).searchParams;
  assert.equal(olq.get('title'), 'The Hobbit', '"(Unabridged)" stripped from the search');
  assert.equal(olq.get('author'), 'J.R.R. Tolkien');

  const b = item({ id: 'ab-hobbit-gb', library_id: 'lib-ab', type: 'audiobook', title: 'The Hobbit', genres: '["Audiobook"]', people, extra: JSON.stringify({ author: 'J.R.R. Tolkien' }) });
  await builtin.applyBuiltinProviders(b, { only: ['googlebooks'] });
  r = row(b);
  assert.equal(r.overview, 'A great modern classic and the prelude to The Lord of the Rings.');
  assert.equal(r.release_date, '2009-04-20');
  assert.deepEqual(JSON.parse(r.genres), ['Fiction', 'Fantasy', 'Classic']);
  assert.deepEqual(JSON.parse(r.studios), ['HarperCollins UK']);
  assert.equal(JSON.parse(r.external_ids).isbn, '9780007322602');
  assert.match(imgSource(r.poster)!, /^https:\/\/books\.google\.com\/.*zoom=1/);
  assert.ok(!imgSource(r.poster)!.includes('edge=curl'));
  assert.ok(!hitsFor('/gb/').some((h) => h.path.includes('key=')), 'no key parameter without a key');
});

test('LRCLIB: synced lyrics for a track, hits and misses cached', async () => {
  const artist = item({ id: 'art-bs', library_id: 'lib-mus', type: 'artist', title: 'Borislav Slavov' });
  const album = item({ id: 'alb-bg3', library_id: 'lib-mus', type: 'album', title: "Baldur's Gate 3 (Original Game Soundtrack)", parent_id: artist });
  const track = item({ id: 'trk-iwtl', library_id: 'lib-mus', type: 'track', title: 'I Want to Live', parent_id: album, grandparent_id: artist, duration_ms: 233400 });
  const l = await fetchLrclib(track);
  assert.ok(l);
  assert.equal(l!.source, 'lrclib');
  assert.equal(l!.synced, true);
  assert.deepEqual(l!.lines[0], { startMs: 17120, text: 'I feel your breath upon my neck' });
  const q = new URL(base + hitsFor('/lrclib/api/get').at(-1)!.path).searchParams;
  assert.equal(q.get('duration'), '233');
  assert.equal(q.get('album_name'), "Baldur's Gate 3 (Original Game Soundtrack)");
  const before = hitsFor('/lrclib/').length;
  await fetchLrclib(track);
  assert.equal(hitsFor('/lrclib/').length, before, 'second lookup served from the cache');
  const miss = item({ id: 'trk-miss', library_id: 'lib-mus', type: 'track', title: 'Unknown Song', parent_id: album, grandparent_id: artist });
  assert.equal(await fetchLrclib(miss), null);
  assert.equal(await fetchLrclib(miss), null);
  assert.equal(hitsFor('/lrclib/').length, before + 1, '404 is cached too');
  updateMetadataSettings({ providers: { ...getMetadataSettings().providers, lrclib: { enabled: false, apiKey: null } } });
  clearCache('lrclib');
  assert.equal(await fetchLrclib(track), null, 'toggle off: no lookup');
  assert.equal(hitsFor('/lrclib/').length, before + 1);
  updateMetadataSettings({ providers: { ...getMetadataSettings().providers, lrclib: { enabled: true, apiKey: null } } });
});

test('OMDb: IMDb / Rotten Tomatoes / Metacritic ratings on Item.ratings, gaps filled', async () => {
  const movie = item({ id: 'mov-matrix-omdb', library_id: 'lib-mov', type: 'movie', title: 'The Matrix', year: 1999, external_ids: '{"imdb":"tt0133093"}', overview: 'Local plot.' });
  await builtin.applyBuiltinProviders(movie, { only: ['omdb'] });
  const r = row(movie);
  assert.deepEqual(JSON.parse(r.ratings), { imdb: 8.7, rottenTomatoes: 83, metacritic: 73 });
  assert.equal(r.overview, 'Local plot.', 'existing plot kept');
  assert.deepEqual(JSON.parse(r.genres), ['Action', 'Sci-Fi']);
  assert.equal(r.content_rating, 'R');
  assert.equal(r.community_rating, 8.7);
  assert.deepEqual(rowToItem(r).ratings, { imdb: 8.7, rottenTomatoes: 83, metacritic: 73 });
  const t = await builtin.testProvider('omdb', { apiKey: 'wrong' });
  assert.equal(t.ok, false);
  assert.match(t.message, /rejected|Invalid API key/i);
  const ok = await builtin.testProvider('omdb');
  assert.equal(ok.ok, true, ok.message);
  assert.match(ok.message, /IMDb 8.7, RT 83%, MC 73/);
});

test('MusicBrainz: MBIDs, genres, Cover Art Archive only without a cover, 1 request/second', async () => {
  const artist = item({ id: 'art-rh', library_id: 'lib-mus', type: 'artist', title: 'Radiohead' });
  const album = item({ id: 'alb-okc', library_id: 'lib-mus', type: 'album', title: 'OK Computer', parent_id: artist });
  const start = hitsFor('/mb/').length;
  await builtin.applyBuiltinProviders(artist, { only: ['musicbrainz'] });
  await builtin.applyBuiltinProviders(album, { only: ['musicbrainz'] });
  const a = row(artist);
  assert.equal(JSON.parse(a.external_ids).musicbrainzArtist, MBID_RADIOHEAD);
  assert.deepEqual(JSON.parse(a.genres), ['Alternative Rock', 'Art Rock', 'British']);
  assert.equal(a.overview, 'Radiohead: Group, from United Kingdom, active since 1991.');
  const b = row(album);
  assert.equal(JSON.parse(b.external_ids).musicbrainzReleaseGroup, RG_OKC);
  assert.equal(b.year, 1997);
  assert.equal(imgSource(b.poster), `${base}/caa/release-group/${RG_OKC}/front-500`);
  const mb = hitsFor('/mb/').slice(start);
  assert.equal(mb.length, 4);
  for (let i = 1; i < mb.length; i++) assert.ok(mb[i].at - mb[i - 1].at >= 1000, `MusicBrainz requests ≥1s apart (got ${mb[i].at - mb[i - 1].at}ms)`);
  assert.ok(hitsFor(`/mb/ws/2/artist/${MBID_RADIOHEAD}`)[0].path.includes('inc=genres+tags'));
  // An album that already has a cover never asks the Cover Art Archive.
  const caaBefore = hitsFor('/caa/').length;
  db.run('UPDATE items SET poster = ? WHERE id = ?', registerImage('https://example.com/cover.jpg'), album);
  clearCache('musicbrainz');
  await builtin.applyBuiltinProviders(album, { only: ['musicbrainz'] });
  assert.equal(hitsFor('/caa/').length, caaBefore);
});

test('Fix match: MusicBrainz search + apply by id replaces the wrong match', async () => {
  const album = item({
    id: 'alb-wrong', library_id: 'lib-mus', type: 'album', title: 'OKC', parent_id: 'art-rh', genres: '["Polka"]',
    external_ids: JSON.stringify({ musicbrainzReleaseGroup: 'wrong-id', audiodbAlbum: '1' }), poster: registerImage('https://example.com/wrong.jpg'),
  });
  const s = await builtin.searchMatch(album, { query: 'OK Computer' });
  assert.equal(s.provider, 'musicbrainz');
  assert.equal(s.results[0].id, RG_OKC);
  assert.match(s.results[0].subtitle!, /Radiohead · Album/);
  const q = new URL(base + hitsFor('/mb/ws/2/release-group?').at(-1)!.path).searchParams.get('query');
  assert.equal(q, 'releasegroup:"OK Computer" AND artist:"Radiohead"');
  await builtin.applyMatch(album, 'musicbrainz', RG_OKC, refreshItem);
  const r = row(album);
  const ids = JSON.parse(r.external_ids);
  assert.equal(ids.musicbrainzReleaseGroup, RG_OKC);
  assert.equal(ids.audiodbAlbum, undefined, 'ids from the old match are dropped');
  assert.deepEqual(JSON.parse(r.genres), ['Art Rock'], 'replace mode overwrites unlocked fields');
  assert.equal(imgSource(r.poster), `${base}/caa/release-group/${RG_OKC}/front-500`, 'remote art from the wrong match is replaced');
  await assert.rejects(builtin.applyMatch(album, 'tvdb', '1', refreshItem), /cannot match/);
  await assert.rejects(builtin.applyMatch(album, 'musicbrainz', '../../etc', refreshItem), /Invalid id/);
});

test('Refresh all: built-in providers run for music and audiobook libraries with progress; missing counts', async () => {
  const before = builtin.metadataAdminState().providers.find((p) => p.id === 'audnexus')!;
  assert.ok(before.missing !== null && before.missing >= 2, 'audiobooks without an ASIN are counted');
  const progress: [number, number][] = [];
  db.run("UPDATE items SET providers_fetched_at = NULL WHERE library_id = 'lib-ab'");
  await enrichLibrary('lib-ab', { onProgress: (d, t) => progress.push([d, t]) });
  assert.ok(progress.length >= 3);
  assert.deepEqual(progress.at(-1), [progress.at(-1)![1], progress.at(-1)![1]]);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM items WHERE library_id = 'lib-ab' AND providers_fetched_at IS NULL")!.n, 0);
  // Without refresh, already-fetched items are skipped.
  const n = hits.length;
  progress.length = 0;
  await enrichLibrary('lib-ab');
  assert.equal(hits.length, n);
});

test('HTTP cache: entries expire after the TTL; test requests bypass the cache', async () => {
  const u = `${base}/omdb/?apikey=omdb-key&i=tt0133093`;
  clearCache('omdb');
  const n0 = hitsFor('/omdb').length;
  await providerFetch('omdb', u, { ttlHours: 1 });
  await providerFetch('omdb', u, { ttlHours: 1 });
  assert.equal(hitsFor('/omdb').length, n0 + 1);
  db.run("UPDATE metadata_cache SET expires_at = 0 WHERE provider = 'omdb'");
  const r = await providerFetch('omdb', u, { ttlHours: 1 });
  assert.equal(r.cached, false);
  assert.equal(hitsFor('/omdb').length, n0 + 2);
  await builtin.testProvider('omdb');
  await builtin.testProvider('omdb');
  assert.equal(hitsFor('/omdb').length, n0 + 4, 'Test always asks the service');
  const rows = db.all<{ key: string }>('SELECT key FROM metadata_cache');
  assert.ok(rows.every((x) => !x.key.includes('omdb-key')), 'cache keys are hashes (no API keys stored in clear)');
});

test('provider Test buttons report success and failure', async () => {
  for (const id of ['tvdb', 'fanart', 'audiodb', 'audnexus', 'openlibrary', 'googlebooks', 'musicbrainz'] as const) {
    const r = await builtin.testProvider(id);
    assert.equal(r.ok, true, `${id}: ${r.message}`);
  }
  const bad = await builtin.testProvider('tvdb', { apiKey: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /rejected/);
  const tmdbTest = await builtin.testProvider('tmdb');
  assert.equal(tmdbTest.ok, false, 'TMDB without a key fails clearly');
});

test('HTTP API: admin settings are masked, Test, Fix match endpoints, episode order on PATCH', async () => {
  const { buildApp } = await import('../src/app.ts');
  const app = await buildApp();
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { serverName: 'T', username: 'admin', password: 'correct horse battery', deviceId: 'd1', deviceName: 'test', platform: 'test' } });
    assert.equal(setup.statusCode, 200, setup.body);
    const token = setup.json().token as string;
    const h = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/metadata' })).statusCode, 401);
    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/metadata', headers: h });
    assert.equal(get.statusCode, 200);
    assert.ok(!get.body.includes('omdb-key') && !get.body.includes('tvdb-key'), 'keys never leave the server');
    assert.equal(get.json().settings.providers.omdb.apiKey, SECRET_MASK);
    const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/metadata', headers: h, payload: { providers: { omdb: { enabled: true, apiKey: SECRET_MASK } }, cacheTtlHours: 48 } });
    assert.equal(put.statusCode, 200);
    assert.equal(getMetadataSettings().providers.omdb.apiKey, 'omdb-key');
    assert.equal(getMetadataSettings().cacheTtlHours, 48);
    const t = await app.inject({ method: 'POST', url: '/api/v1/admin/metadata/omdb/test', headers: h, payload: {} });
    assert.equal(t.json().ok, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/metadata/nope/test', headers: h, payload: {} })).statusCode, 400);
    const m = await app.inject({ method: 'GET', url: '/api/v1/items/ab-phm/match?provider=audnexus&q=B08G9PRS1K', headers: h });
    assert.equal(m.statusCode, 200, m.body);
    assert.equal(m.json().results[0].id, 'B08G9PRS1K');
    const applied = await app.inject({ method: 'POST', url: '/api/v1/items/ab-phm/match', headers: h, payload: { provider: 'audnexus', id: 'B08G9PRS1K' } });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(applied.json().title, 'Project Hail Mary', 'replace mode takes the provider title');
    assert.equal(applied.json().chapters.length, 2, 'Audnexus chapters on the audiobook');
    const ep = await app.inject({ method: 'PATCH', url: '/api/v1/items/show-cb', headers: h, payload: { episodeOrder: 'dvd' } });
    assert.equal(ep.statusCode, 200);
    assert.equal(ep.json().episodeOrder, 'dvd');
    const movie = await app.inject({ method: 'GET', url: '/api/v1/items/mov-matrix', headers: h });
    assert.ok(movie.json().extraArt?.clearArtUrl?.startsWith('/api/v1/images/'));
    await new Promise((r) => setTimeout(r, 200)); // let the background re-match finish
    assert.equal(row('ep-cb1').title, 'Asteroid Blues');
  } finally {
    await app.close();
  }
});
