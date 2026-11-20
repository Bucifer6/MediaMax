// OMDb Metadata — an example metadata-provider plugin (metadata + tasks + settings).
/** @type {import('../../sdk/index').ActivateFn} */
export async function activate(ctx) {
  const base = 'https://www.omdbapi.com/';
  async function lookup(item) {
    const key = ctx.settings.get('apiKey');
    if (!key) return null;
    const q = new URLSearchParams({ apikey: key, plot: ctx.settings.get('plot') || 'short' });
    if (item.externalIds?.imdb) q.set('i', item.externalIds.imdb);
    else {
      q.set('t', item.title);
      if (item.year) q.set('y', String(item.year));
      q.set('type', item.type === 'show' ? 'series' : 'movie');
    }
    const res = await fetch(`${base}?${q}`, { signal: AbortSignal.timeout(10000) });
    const j = await res.json();
    if (j.Response !== 'True') return null;
    const n = (v) => (v && v !== 'N/A' ? v : undefined);
    return {
      overview: n(j.Plot),
      genres: n(j.Genre)?.split(',').map((g) => g.trim()),
      communityRating: n(j.imdbRating) ? Number(j.imdbRating) : undefined,
      contentRating: n(j.Rated),
      posterUrl: n(j.Poster),
      externalIds: n(j.imdbID) ? { imdb: j.imdbID } : undefined,
    };
  }
  ctx.metadata.registerProvider({ name: 'OMDb', types: ['movie', 'show'], fetch: lookup });
  ctx.tasks.register({
    id: 'check', name: 'OMDb: check API key', description: 'Verifies the configured OMDb API key works.',
    run: async () => {
      const r = await lookup({ title: 'The Matrix', year: 1999, type: 'movie', externalIds: {} });
      if (!r) throw new Error('OMDb did not return data — check the API key');
      ctx.log.info('OMDb API key works');
    },
  });
}
