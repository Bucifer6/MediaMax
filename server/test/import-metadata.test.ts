import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Session, SrcMeta, SrcSeries } from '../src/services/import/common.ts';

const { db } = await import('../src/db.ts');
const { Matcher } = await import('../src/services/import/common.ts');
const { importMetadata } = await import('../src/services/import/metadata.ts');
const { embyMeta } = await import('../src/services/import/emby.ts');
const { plexMeta } = await import('../src/services/import/plex.ts');

/* Kinora side: a movie with some metadata already, a show with a season and an episode, a locked movie. */
const now = new Date().toISOString();
db.insert('libraries', { id: 'lib-m', name: 'Movies', type: 'movies', paths: JSON.stringify(['/m']), created_at: now });
db.insert('libraries', { id: 'lib-t', name: 'TV', type: 'shows', paths: JSON.stringify(['/t']), created_at: now });
const item = (id: string, library_id: string, type: string, title: string, extra: Record<string, unknown> = {}) =>
  db.insert('items', { id, library_id, type, title, sort_title: title.toLowerCase(), added_at: now, updated_at: now, ...extra });
item('m-matrix', 'lib-m', 'movie', 'The Matrix', { year: 1999, external_ids: JSON.stringify({ tmdb: '603' }), tagline: 'Kept tagline' });
item('m-locked', 'lib-m', 'movie', 'Heat', { year: 1995, external_ids: JSON.stringify({ tmdb: '949' }), locked_fields: JSON.stringify(['overview', 'poster']) });
item('s-sb', 'lib-t', 'show', 'SpongeBob SquarePants', { year: 1999, external_ids: JSON.stringify({ tvdb: '75886' }) });
item('se-sb1', 'lib-t', 'season', 'Season 1', { parent_id: 's-sb', idx: 1 });
item('e-sb1', 'lib-t', 'episode', 'Help Wanted', { parent_id: 'se-sb1', grandparent_id: 's-sb', parent_idx: 1, idx: 1 });

/* Source side. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f1d7d60000000049454e44ae426082', 'hex');
const series: SrcSeries = { id: 'ser', title: 'SpongeBob SquarePants', year: 1999, providerIds: { Tvdb: '75886' } };
const items: SrcMeta[] = [
  {
    item: { id: 'a', kind: 'movie', title: 'The Matrix', year: 1999, providerIds: { Tmdb: '603' } },
    overview: 'A hacker learns the truth.', tagline: 'Free your mind', genres: ['Action', 'Science Fiction'], studios: ['Warner Bros.'],
    people: [{ name: 'Keanu Reeves', role: 'Neo', kind: 'actor' }], contentRating: 'R', communityRating: 8.7, releaseDate: '1999-03-31',
    images: { poster: 'img:poster', backdrop: 'img:svg', logo: 'img:missing' },
  },
  { item: { id: 'b', kind: 'movie', title: 'Heat', year: 1995, providerIds: { Tmdb: '949' } }, overview: 'Cops and robbers.', genres: ['Crime'], images: { poster: 'img:poster' } },
  { item: { id: 'c', kind: 'show', title: 'SpongeBob SquarePants', year: 1999, providerIds: { Tvdb: '75886' } }, overview: 'A sponge.', images: { poster: 'img:poster' } },
  { item: { id: 'd', kind: 'season', seriesId: 'ser', season: 1 }, images: { poster: 'img:poster' } },
  { item: { id: 'e', kind: 'episode', seriesId: 'ser', season: 1, episode: 1, title: 'Help Wanted' }, overview: 'First day.', images: { thumb: 'img:poster' } },
  { item: { id: 'f', kind: 'movie', title: 'Not In Kinora', year: 2001, providerIds: { Tmdb: '1' } }, overview: 'x', images: { poster: 'img:poster' } },
];
const fetched: string[] = [];
const session = {
  metadata: async () => ({ items, series: new Map([['ser', series]]) }),
  fetchImage: async (ref: string) => {
    fetched.push(ref);
    if (ref === 'img:poster') return { data: PNG, type: 'image/png' };
    if (ref === 'img:svg') return { data: Buffer.from('<svg/>'), type: 'image/svg+xml' };
    return null;
  },
} as unknown as Session;

const row = (id: string) => db.get<Record<string, any>>('SELECT * FROM items WHERE id = ?', id)!;

test('fills missing metadata and artwork, respects existing values and locks', async () => {
  const r = await importMetadata(session, new Matcher([]), { overwrite: false }, () => undefined);
  assert.equal(r.read, 6);
  assert.equal(r.matched, 5);
  const m = row('m-matrix');
  assert.equal(m.overview, 'A hacker learns the truth.');
  assert.equal(m.tagline, 'Kept tagline', 'existing values are kept without overwrite');
  assert.deepEqual(JSON.parse(m.genres), ['Action', 'Science Fiction']);
  assert.deepEqual(JSON.parse(m.people), [{ name: 'Keanu Reeves', role: 'Neo', kind: 'actor', imageUrl: null }]);
  assert.equal(m.content_rating, 'R');
  assert.equal(m.community_rating, 8.7);
  assert.equal(m.release_date, '1999-03-31');
  assert.ok(m.poster, 'poster downloaded');
  assert.equal(m.backdrop, null, 'SVG is never stored');
  assert.equal(m.logo, null, 'missing image is skipped');
  const img = db.get<{ source: string }>('SELECT source FROM images WHERE id = ?', m.poster)!;
  assert.match(img.source.replace(/\\/g, '/'), /\/artwork\/import\/.+-poster-[0-9a-f]{10}\.png$/);

  const h = row('m-locked');
  assert.equal(h.overview, null, 'locked field untouched');
  assert.equal(h.poster, null, 'locked artwork untouched');
  assert.deepEqual(JSON.parse(h.genres), ['Crime']);

  assert.equal(row('s-sb').overview, 'A sponge.');
  assert.ok(row('se-sb1').poster, 'season poster through its show');
  assert.equal(row('e-sb1').overview, 'First day.');
  assert.ok(row('e-sb1').thumb, 'episode still goes to thumb');
  assert.ok(!fetched.includes('img:poster') || r.images >= 4);
});

test('a second run downloads nothing new; overwrite replaces existing values', async () => {
  fetched.length = 0;
  const again = await importMetadata(session, new Matcher([]), { overwrite: false }, () => undefined);
  assert.equal(again.images, 0);
  assert.deepEqual(fetched.filter((f) => f === 'img:poster'), [], 'artwork already present is not fetched again');

  const over = await importMetadata(session, new Matcher([]), { overwrite: true }, () => undefined);
  assert.equal(row('m-matrix').tagline, 'Free your mind');
  assert.equal(row('m-locked').overview, null, 'locks hold even with overwrite');
  assert.ok(over.updated >= 1);
});

test('Emby items map to neutral metadata', () => {
  const m = embyMeta({
    Id: 'x1', Type: 'Movie', Name: 'The Matrix', ProductionYear: 1999, ProviderIds: { Tmdb: '603' }, Overview: 'o', Taglines: ['t'], Genres: ['Action'],
    Studios: [{ Name: 'WB' }], People: [{ Name: 'Keanu', Role: 'Neo', Type: 'Actor' }, { Name: 'Lana', Type: 'Director' }, { Name: 'X', Type: 'GuestStar' }],
    OfficialRating: 'R', CommunityRating: 8.7, PremiereDate: '1999-03-31T00:00:00.0000000Z', ImageTags: { Primary: 'a', Logo: 'b' }, BackdropImageTags: ['c'],
  })!;
  assert.equal(m.item.kind, 'movie');
  assert.equal(m.tagline, 't');
  assert.deepEqual(m.studios, ['WB']);
  assert.deepEqual(m.people!.map((p) => p.kind), ['actor', 'director', 'actor']);
  assert.equal(m.releaseDate, '1999-03-31');
  assert.match(m.images.poster!, /^\/Items\/x1\/Images\/Primary\?/);
  assert.match(m.images.backdrop!, /^\/Items\/x1\/Images\/Backdrop\/0\?/);
  assert.ok(m.images.logo);
  assert.equal(m.images.thumb, undefined);
  const season = embyMeta({ Id: 's1', Type: 'Season', IndexNumber: 2, SeriesId: 'ser', ImageTags: { Primary: 'p' } })!;
  assert.deepEqual([season.item.kind, season.item.season, season.item.seriesId], ['season', 2, 'ser']);
  assert.ok(season.images.poster);
  const ep = embyMeta({ Id: 'e1', Type: 'Episode', SeriesId: 'ser', ParentIndexNumber: 1, IndexNumber: 3, ImageTags: { Primary: 'p' } })!;
  assert.ok(ep.images.thumb && !ep.images.poster);
  assert.equal(embyMeta({ Id: 'b', Type: 'BoxSet' }), null);
});

test('Plex items map to neutral metadata; only server paths become artwork refs', () => {
  const m = plexMeta({
    ratingKey: '10', type: 'movie', title: 'Heat', year: 1995, summary: 's', tagline: 't', studio: 'WB', contentRating: 'R', audienceRating: 8.3,
    originallyAvailableAt: '1995-12-15', thumb: '/library/metadata/10/thumb/1', art: 'https://evil.example/x.jpg',
    Genre: [{ tag: 'Crime' }], Role: [{ tag: 'Al Pacino', role: 'Hanna' }], Director: [{ tag: 'Michael Mann' }],
    Image: [{ type: 'clearLogo', url: '/library/metadata/10/clearLogo/1' }],
  })!;
  assert.equal(m.overview, 's');
  assert.deepEqual(m.studios, ['WB']);
  assert.equal(m.communityRating, 8.3);
  assert.deepEqual(m.people!.map((p) => `${p.kind}:${p.name}`), ['actor:Al Pacino', 'director:Michael Mann']);
  assert.equal(m.images.poster, '/library/metadata/10/thumb/1');
  assert.equal(m.images.backdrop, undefined, 'absolute URLs are not followed');
  assert.equal(m.images.logo, '/library/metadata/10/clearLogo/1');
  const season = plexMeta({ ratingKey: '20', type: 'season', index: 1, parentRatingKey: '19', thumb: '/library/metadata/20/thumb/1' })!;
  assert.deepEqual([season.item.kind, season.item.season, season.item.seriesId], ['season', 1, '19']);
});
