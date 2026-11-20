// MusicBrainz + Cover Art Archive — artist/album matching, MBIDs, genres and covers. Only fills empty, unlocked fields.
/** @type {import('../../sdk/index').ActivateFn} */
export async function activate(ctx) {
  const api = () => (ctx.settings.get('apiUrl') || 'https://musicbrainz.org/ws/2').replace(/\/+$/, '');
  const caa = () => (ctx.settings.get('coverUrl') || 'https://coverartarchive.org').replace(/\/+$/, '');
  const ua = () => `MediaMax/${ctx.serverVersion}${ctx.settings.get('contact') ? ` ( ${ctx.settings.get('contact')} )` : ''}`;
  const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

  // MusicBrainz allows one request per second per client; queue everything through one gate.
  let chain = Promise.resolve();
  const gate = (fn) => {
    const run = chain.then(() => new Promise((r) => setTimeout(r, 1100))).then(fn);
    chain = run.catch(() => {});
    return run;
  };
  const get = (url) => gate(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': ua(), accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 503) throw new Error('MusicBrainz is rate limiting; try again later');
    if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
    return res.json();
  });
  const genresOf = (x) => [...(x.genres ?? []), ...(x.tags ?? [])]
    .filter((g) => (g.count ?? 1) > 0).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .map((g) => g.name.replace(/\b\w/g, (c) => c.toUpperCase())).filter((g, i, a) => a.indexOf(g) === i).slice(0, 5);

  async function artist(item) {
    let mbid = item.externalIds?.musicbrainzArtist;
    if (!mbid) {
      const q = encodeURIComponent(`artist:"${item.title.replace(/"/g, '')}"`);
      const r = await get(`${api()}/artist?query=${q}&limit=5&fmt=json`);
      const hit = (r.artists ?? []).find((a) => a.score >= 90 && (norm(a.name) === norm(item.title) || (a.aliases ?? []).some((x) => norm(x.name) === norm(item.title))));
      if (!hit) return null;
      mbid = hit.id;
    }
    const a = await get(`${api()}/artist/${mbid}?inc=genres+tags&fmt=json`);
    const life = a['life-span'] ?? {};
    const bits = [a.type, a.disambiguation, a.area?.name ? `from ${a.area.name}` : null, life.begin ? `active since ${life.begin.slice(0, 4)}${life.ended && life.end ? ` until ${life.end.slice(0, 4)}` : ''}` : null].filter(Boolean);
    return {
      overview: bits.length ? `${a.name}: ${bits.join(', ')}.` : undefined,
      genres: genresOf(a).length ? genresOf(a) : undefined,
      externalIds: { musicbrainzArtist: mbid },
    };
  }

  async function album(item) {
    let rg = item.externalIds?.musicbrainzReleaseGroup;
    if (!rg) {
      const parts = [`releasegroup:"${item.title.replace(/"/g, '')}"`];
      if (item.parentTitle) parts.push(`artist:"${item.parentTitle.replace(/"/g, '')}"`);
      const r = await get(`${api()}/release-group?query=${encodeURIComponent(parts.join(' AND '))}&limit=5&fmt=json`);
      const hit = (r['release-groups'] ?? []).find((g) => g.score >= 90 && norm(g.title) === norm(item.title)
        && (!item.parentTitle || (g['artist-credit'] ?? []).some((c) => norm(c.name ?? c.artist?.name) === norm(item.parentTitle))));
      if (!hit) return null;
      rg = hit.id;
    }
    const g = await get(`${api()}/release-group/${rg}?inc=genres+tags&fmt=json`);
    const out = { genres: genresOf(g).length ? genresOf(g) : undefined, externalIds: { musicbrainzReleaseGroup: rg } };
    if (ctx.settings.get('covers') !== false) {
      // Cover Art Archive redirects to the image; a HEAD tells us whether a front cover exists.
      const url = `${caa()}/release-group/${rg}/front-500`;
      const head = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': ua() }, signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (head && (head.status === 200 || (head.status >= 300 && head.status < 400))) out.posterUrl = url;
    }
    return out;
  }

  ctx.metadata.registerProvider({
    name: 'MusicBrainz',
    types: ['artist', 'album'],
    fetch: (item) => (item.type === 'artist' ? artist(item) : album(item)),
  });
  ctx.log.info('MusicBrainz metadata provider ready');
}
