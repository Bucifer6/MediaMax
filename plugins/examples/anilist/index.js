// AniList — anime metadata for shows and movies (GraphQL, no key). Only fills empty, unlocked fields.
/** @type {import('../../sdk/index').ActivateFn} */
export async function activate(ctx) {
  const QUERY = `query ($search: String, $format: [MediaFormat]) {
    Page(perPage: 8) { media(search: $search, type: ANIME, format_in: $format, sort: SEARCH_MATCH) {
      id idMal format seasonYear startDate { year } title { romaji english native } synonyms
      description(asHtml: false) genres averageScore isAdult coverImage { extraLarge large } bannerImage
    } }
  }`;
  const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  // AniList asks clients to stay under 90 requests/minute.
  let last = 0;
  const pace = async () => {
    const wait = last + 700 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };

  async function search(title, format) {
    await pace();
    const res = await fetch(ctx.settings.get('apiUrl') || 'https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { search: title, format } }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) throw new Error('AniList rate limit hit; try again later');
    if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
    const j = await res.json();
    return j?.data?.Page?.media ?? [];
  }

  function pick(results, item) {
    const want = norm(item.title);
    const english = ctx.settings.get('titleLanguage') === 'english';
    const strict = ctx.settings.get('minScore') !== 'loose';
    const year = (m) => m.seasonYear ?? m.startDate?.year ?? null;
    const titles = (m) => (english ? [m.title.english] : [m.title.english, m.title.romaji, m.title.native, ...(m.synonyms || [])]).filter(Boolean).map(norm);
    const scored = results
      .filter((m) => !m.isAdult)
      .map((m) => {
        const exact = titles(m).includes(want);
        const yearOk = !item.year || !year(m) || Math.abs(year(m) - item.year) <= 1;
        return { m, score: (exact ? 2 : 0) + (yearOk ? 1 : 0) };
      })
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (!top) return null;
    if (strict && top.score < 3) return null;
    return top.m;
  }

  ctx.metadata.registerProvider({
    name: 'AniList',
    types: ['show', 'movie'],
    async fetch(item) {
      const m = pick(await search(item.title, item.type === 'movie' ? ['MOVIE'] : ['TV', 'TV_SHORT', 'ONA', 'OVA']), item);
      if (!m) return null;
      const clean = (s) => s?.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\(Source:[^)]*\)\s*$/i, '').replace(/\n{3,}/g, '\n\n').trim();
      return {
        overview: clean(m.description) || undefined,
        genres: m.genres?.length ? [...new Set(['Anime', ...m.genres])] : undefined,
        communityRating: m.averageScore ? Math.round(m.averageScore) / 10 : undefined,
        posterUrl: m.coverImage?.extraLarge || m.coverImage?.large || undefined,
        backdropUrl: m.bannerImage || undefined,
        externalIds: { anilist: String(m.id), ...(m.idMal ? { mal: String(m.idMal) } : {}) },
      };
    },
  });
  ctx.log.info('AniList metadata provider ready');
}
