import type { MatchCandidate, MetadataProviderConfig } from '@mediamax/shared';
import { baseUrl, norm, providerFetch, url } from '../http.js';
import { stripHtml, yearOf, type BuiltinProvider, type ProviderItem, type ProviderResult } from './types.js';

/** Book fallbacks for audiobooks: Open Library (no key) and Google Books (optional key). */

const titleMatch = (a: string | null | undefined, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' '));
};
const authorMatch = (names: string[] | undefined, author: string | null) =>
  !author || !names?.length || names.some((n) => norm(n) === norm(author) || norm(n).split(' ').pop() === norm(author).split(' ').pop());

/** Strip "(Unabridged)", "Book 1" style noise from audiobook titles before a book search. */
const cleanTitle = (t: string) => t.replace(/\s*[[(](un)?abridged[\])]\s*/gi, ' ').replace(/\s*[[(][^\])]*\b(B0[0-9A-Z]{8})\b[^\])]*[\])]/g, ' ').trim();

/* ------------------------------ Open Library ----------------------------- */

const GENERIC_SUBJECTS = /^(accessible book|protected daisy|in library|fiction|large type books|open library staff picks|nyt:.*|new york times .*|reading level.*|overdrive|audiobooks?|english language)$/i;
const subjects = (list: string[] | undefined) =>
  (list ?? []).filter((x) => x && x.length < 40 && !GENERIC_SUBJECTS.test(x) && !/[=:]/.test(x)).map((x) => x.replace(/\b\w/g, (c) => c.toUpperCase())).filter((x, i, a) => a.indexOf(x) === i).slice(0, 5);

const olCover = (id: number | string | null | undefined) => (id ? `${baseUrl('openlibraryCovers')}/b/id/${id}-L.jpg` : null);

async function olSearch(title: string, author: string | null, limit = 5, ttlHours?: number): Promise<any[]> {
  const r = await providerFetch('openlibrary', url(baseUrl('openlibrary'), '/search.json', {
    title: cleanTitle(title), author: author ?? undefined, limit, fields: 'key,title,author_name,first_publish_year,isbn,subject,cover_i,edition_count',
  }), { ttlHours });
  return r.data?.docs ?? [];
}

async function olWork(key: string): Promise<any | null> {
  const k = key.replace(/^\/?works\//, '');
  return (await providerFetch('openlibrary', url(baseUrl('openlibrary'), `/works/${encodeURIComponent(k)}.json`))).data;
}

async function openLibraryFetch(item: ProviderItem): Promise<ProviderResult | null> {
  if (item.type !== 'audiobook') return null;
  let doc: any = null;
  let key = item.ids.openLibrary ?? null;
  if (!key) {
    const docs = await olSearch(item.title, item.parentTitle);
    doc = docs.find((d) => titleMatch(d.title, cleanTitle(item.title)) && authorMatch(d.author_name, item.parentTitle));
    if (!doc) return null;
    key = String(doc.key).replace(/^\/works\//, '');
  }
  const w = await olWork(key);
  if (!w && !doc) return null;
  const desc = typeof w?.description === 'string' ? w.description : w?.description?.value;
  const isbn = (doc?.isbn ?? []).find((x: string) => x.length === 13) ?? doc?.isbn?.[0];
  const cover = olCover(doc?.cover_i ?? w?.covers?.find((c: number) => c > 0));
  return {
    fields: {
      overview: stripHtml(desc)?.replace(/\(\[source\]\[\d+\]\)|\[\d+\]: https?:\S+/g, '').trim() || null,
      year: doc?.first_publish_year ?? yearOf(w?.first_publish_date),
      genres: subjects(doc?.subject ?? w?.subjects),
    },
    art: cover ? [{ kind: 'poster', url: cover }] : [],
    ids: { openLibrary: key, ...(isbn ? { isbn } : {}) },
    meta: isbn ? { isbn } : undefined,
  };
}

export const openlibrary: BuiltinProvider = {
  id: 'openlibrary',
  name: 'Open Library',
  types: ['audiobook'],
  key: 'none',
  homepage: 'https://openlibrary.org',
  keyUrl: null,
  cost: 'Free, no key (Internet Archive).',
  description: 'Book fallback for audiobooks: description, cover, first publish year, ISBN and subjects (by title + author).',
  rateLimit: '~2 requests/second (client-side); responses are cached.',
  artwork: ['audiobook'],
  fetch: (item) => openLibraryFetch(item),
  async test() {
    const docs = await olSearch('The Hobbit', 'Tolkien', 1, 0);
    if (!docs.length) throw new Error('Open Library returned no results for a known book');
    return `Open Library works (${docs[0].title})`;
  },
  async search(_type, query, _year, _cfg, parentTitle): Promise<MatchCandidate[]> {
    const docs = await olSearch(query, parentTitle, 10, 1);
    return docs.map((d) => ({
      provider: 'openlibrary', id: String(d.key).replace(/^\/works\//, ''), title: d.title, year: d.first_publish_year ?? null,
      subtitle: (d.author_name ?? []).slice(0, 3).join(', ') || null, overview: null, imageUrl: olCover(d.cover_i),
    }));
  },
  matchIdKey: () => 'openLibrary',
  missing: { label: 'audiobooks without a description', where: "i.type = 'audiobook' AND (i.overview IS NULL OR i.overview = '')" },
};

/* ------------------------------ Google Books ----------------------------- */

async function gbSearch(cfg: MetadataProviderConfig, title: string, author: string | null, max = 5, ttlHours?: number): Promise<any[]> {
  const q = [`intitle:${cleanTitle(title)}`, author ? `inauthor:${author}` : null].filter(Boolean).join(' ');
  const r = await providerFetch('googlebooks', url(baseUrl('googlebooks'), '/volumes', { q, maxResults: max, printType: 'books', key: cfg.apiKey ?? undefined }), { ttlHours });
  return r.data?.items ?? [];
}

const gbImage = (v: any): string | null => {
  const u = v?.imageLinks?.extraLarge ?? v?.imageLinks?.large ?? v?.imageLinks?.medium ?? v?.imageLinks?.thumbnail ?? v?.imageLinks?.smallThumbnail;
  return u ? String(u).replace(/^http:/, 'https:').replace(/&edge=curl/, '') : null;
};

function gbResult(vol: any): ProviderResult {
  const v = vol.volumeInfo ?? {};
  const isbn = (v.industryIdentifiers ?? []).find((x: any) => x.type === 'ISBN_13')?.identifier ?? (v.industryIdentifiers ?? []).find((x: any) => x.type === 'ISBN_10')?.identifier;
  const img = gbImage(v);
  return {
    fields: {
      overview: stripHtml(v.description),
      year: yearOf(v.publishedDate),
      releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(v.publishedDate ?? '') ? v.publishedDate : null,
      genres: (v.categories ?? []).flatMap((c: string) => c.split('/').map((x) => x.trim())).filter((x: string, i: number, a: string[]) => x && a.indexOf(x) === i).slice(0, 5),
      studios: v.publisher ? [v.publisher] : [],
      communityRating: v.averageRating ? Math.round(Number(v.averageRating) * 2 * 10) / 10 : null,
    },
    art: img ? [{ kind: 'poster', url: img }] : [],
    ids: { googleBooks: String(vol.id), ...(isbn ? { isbn } : {}) },
    meta: isbn ? { isbn } : undefined,
  };
}

async function googleBooksFetch(item: ProviderItem, cfg: MetadataProviderConfig): Promise<ProviderResult | null> {
  if (item.type !== 'audiobook') return null;
  if (item.ids.googleBooks) {
    const r = await providerFetch('googlebooks', url(baseUrl('googlebooks'), `/volumes/${encodeURIComponent(item.ids.googleBooks)}`, { key: cfg.apiKey ?? undefined }));
    return r.data ? gbResult(r.data) : null;
  }
  const vols = await gbSearch(cfg, item.title, item.parentTitle);
  const hit = vols.find((x) => titleMatch(x.volumeInfo?.title, cleanTitle(item.title)) && authorMatch(x.volumeInfo?.authors, item.parentTitle));
  return hit ? gbResult(hit) : null;
}

export const googlebooks: BuiltinProvider = {
  id: 'googlebooks',
  name: 'Google Books',
  types: ['audiobook'],
  key: 'optional',
  homepage: 'https://books.google.com',
  keyUrl: 'https://console.cloud.google.com/apis/library/books.googleapis.com',
  cost: 'Free; works without a key at a low shared quota, a free API key raises it to 1,000 requests/day.',
  description: 'Book fallback for audiobooks: description, cover, publish date, ISBN, categories and publisher (by title + author).',
  rateLimit: '~5 requests/second (client-side); responses are cached.',
  artwork: ['audiobook'],
  fetch: googleBooksFetch,
  async test(cfg) {
    const vols = await gbSearch(cfg, 'The Hobbit', 'Tolkien', 1, 0);
    if (!vols.length) throw new Error('Google Books returned no results for a known book');
    return `Google Books works${cfg.apiKey ? ' (with key)' : ' (no key)'}: ${vols[0].volumeInfo?.title}`;
  },
  async search(_type, query, _year, cfg, parentTitle): Promise<MatchCandidate[]> {
    const vols = await gbSearch(cfg, query, parentTitle, 10, 1);
    return vols.map((x) => ({
      provider: 'googlebooks', id: String(x.id), title: x.volumeInfo?.title ?? '?', year: yearOf(x.volumeInfo?.publishedDate),
      subtitle: (x.volumeInfo?.authors ?? []).join(', ') || null, overview: stripHtml(x.volumeInfo?.description)?.slice(0, 400) ?? null, imageUrl: gbImage(x.volumeInfo),
    }));
  },
  matchIdKey: () => 'googleBooks',
  missing: { label: 'audiobooks without a description', where: "i.type = 'audiobook' AND (i.overview IS NULL OR i.overview = '')" },
};
