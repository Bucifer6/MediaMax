// "Ask" natural-language search: the built-in parser (English and Romanian), strict validation of language-model
// filters with fallback to the rules, chips, per-user library access / ratings / watched state, semantic ranking
// with stored vectors, and speed on a large library.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.ts');
const { createUser, getUser } = await import('../src/services/auth.ts');
const { parseAsk, validateFilter, chipsFor, removeChips } = await import('../src/services/ask/parser.ts');
const { ask, llmFilter, clearAskCache } = await import('../src/services/ask/search.ts');
const { storeVector, closeVectorWorker } = await import('../src/services/ask/vectors.ts');
const { getSettings, updateSettings } = await import('../src/services/settings.ts');

const NOW = new Date(2026, 10, 21);
const f = (q: string) => parseAsk(q, NOW).filter;

/* ------------------------------ parser ------------------------------ */

test('English: runtime, mood, unwatched, decade, language, people, like, rating', () => {
  assert.deepEqual(f("something funny under 90 minutes we haven't seen"), { maxRuntimeMin: 90, types: ['movie'], unwatched: true, genres: ['Comedy'] });
  assert.deepEqual(f('romanian comedies from the 2000s'), { yearFrom: 2000, yearTo: 2009, language: 'ro', genres: ['Comedy'] });
  const like = f('like Inception but lighter');
  assert.equal(like.likeTitle, 'Inception');
  assert.equal(like.tone, 'lighter');
  assert.equal(like.keywords, undefined, '"but" is not a keyword');
  const heist = f('that heist film with red jumpsuits');
  assert.ok(heist.keywords!.includes('heist') && heist.keywords!.includes('jumpsuits') && heist.keywords!.includes('red'));
  assert.deepEqual(f('movies with Tom Hanks from the 90s'), { people: ['Tom Hanks'], types: ['movie'], yearFrom: 1990, yearTo: 1999 });
  assert.deepEqual(f('highly rated sci-fi after 2015'), { yearFrom: 2016, minRating: 7, genres: ['Science Fiction'] });
  assert.equal(f('thriller less than 2 hours').maxRuntimeMin, 120);
  assert.equal(f('a movie over 2 and a half hours').minRuntimeMin, 150);
  assert.deepEqual(f('80s horror'), { yearFrom: 1980, yearTo: 1989, genres: ['Horror'] });
  assert.equal(f('something recent').yearFrom, 2023);
  assert.equal(f('rated 8+ dramas').minRating, 8);
  assert.deepEqual(f('tv shows to rewatch').types, ['show']);
  assert.equal(f('tv shows to rewatch').watched, true);
});

test('Romanian (with or without diacritics)', () => {
  assert.deepEqual(f('comedii românești din anii 2000'), { yearFrom: 2000, yearTo: 2009, language: 'ro', genres: ['Comedy'] });
  assert.deepEqual(f('comedii romanesti din anii 2000'), f('comedii românești din anii 2000'));
  assert.deepEqual(f('ceva amuzant sub 90 de minute pe care nu l-am văzut'), { maxRuntimeMin: 90, types: ['movie'], unwatched: true, genres: ['Comedy'] });
  assert.deepEqual(f("filme de groază din anii '80"), { types: ['movie'], yearFrom: 1980, yearTo: 1989, genres: ['Horror'] });
  assert.deepEqual(f('seriale polițiste coreene'), { types: ['show'], language: 'ko', genres: ['Mystery'] });
  const like = f('ceva ca Interstellar dar mai vesel');
  assert.equal(like.likeTitle, 'Interstellar');
  assert.equal(like.tone, 'lighter');
  assert.deepEqual(f('film românesc regizat de Cristian Mungiu'), { people: ['Cristian Mungiu'], types: ['movie'], language: 'ro' });
  assert.equal(f('filme lungi bine cotate').minRuntimeMin, 140);
  assert.equal(f('filme lungi bine cotate').minRating, 7);
  assert.equal(f('mai puțin de două ore').maxRuntimeMin, 120);
  assert.equal(f('desene animate pentru copii').genres!.includes('Animation'), true);
});

test('LLM filters are validated strictly (unknown keys, bad types, unknown genres, ranges)', () => {
  const v = validateFilter({
    types: ['film', 'tv', 'podcast'], genres: ['comedy', 'Comedie', 'Sci-Fi & Fantasy', 'Underwater Basket Weaving'], maxRuntimeMin: '95', minRuntimeMin: 300,
    yearFrom: 2010, yearTo: 1990, minRating: 42, language: 'Romanian', people: ['Tom Hanks', 7], unwatched: 'yes', sort: 'chaos', sql: 'DROP TABLE items', keywords: ['Heist', ''],
  });
  assert.deepEqual(v, { types: ['movie', 'show'], genres: ['Comedy', 'Fantasy'], maxRuntimeMin: 95, yearFrom: 1990, yearTo: 2010, language: 'ro', people: ['Tom Hanks'], keywords: ['heist'] });
  assert.equal(validateFilter('{"genres":["Comedy"]}'), null);
  assert.equal(validateFilter([]), null);
  assert.equal(validateFilter({ nonsense: true }), null);
});

test('LLM reply that is not valid JSON (or not the schema) falls back to the rules', async () => {
  clearAskCache();
  assert.equal(await llmFilter('q1', async () => 'Sorry, I cannot help with that.'), null);
  assert.equal(await llmFilter('q2', async () => '{"genres": ["Telenovela"], "hack": 1}'), null);
  assert.deepEqual(await llmFilter('q3', async () => 'Here you go: {"genres":["Crime"],"keywords":["heist","jumpsuits"],"titles":["Money Heist"]}'), { genres: ['Crime'], keywords: ['heist', 'jumpsuits'], titles: ['Money Heist'] });
  let n = 0;
  await llmFilter('q3', async () => {
    n++;
    return null;
  });
  assert.equal(n, 0, 'cached per query');
});

test('chips describe the filter and removing one drops exactly that part', () => {
  const fl = f("romanian comedies from the 2000s we haven't seen");
  assert.deepEqual(chipsFor(fl).map((c) => c.label), ['Comedy', '2000s', 'Romanian', 'Unwatched']);
  const r = removeChips(fl, ['years', 'genres:Comedy']);
  assert.deepEqual(r, { language: 'ro', unwatched: true });
});

/* ------------------------------ search ------------------------------ */

const now = new Date().toISOString();
const lib = (id: string, type = 'movies') => db.insert('libraries', { id, name: id, type, paths: '[]', created_at: now });
let n = 0;
const movie = (id: string, library: string, o: { title?: string; genres?: string[]; year?: number; min?: number; rating?: number; cr?: string; overview?: string; lang?: string; people?: string[] } = {}) => {
  db.insert('items', {
    id, library_id: library, type: 'movie', title: o.title ?? id, sort_title: o.title ?? id, year: o.year ?? 2005, duration_ms: (o.min ?? 100) * 60000,
    genres: JSON.stringify(o.genres ?? ['Drama']), community_rating: o.rating ?? 6.5, content_rating: o.cr ?? 'PG', overview: o.overview ?? `Overview ${++n}`,
    people: JSON.stringify((o.people ?? []).map((name) => ({ name, role: null, kind: 'actor' }))), added_at: now, updated_at: now,
  });
  db.insert('media', { id: `${id}-m`, item_id: id, path: `/media/${id}.mkv`, audio: JSON.stringify([{ index: 1, codec: 'aac', language: o.lang ?? 'eng', title: null, channels: 2, default: true }]), subs: '[]' });
};

lib('ask-main');
lib('ask-secret');
movie('m-ro-comedy', 'ask-main', { title: 'Nunta Mută', genres: ['Comedie', 'Dramă'], year: 2008, min: 87, lang: 'rum', overview: 'Într-un sat românesc, o nuntă trebuie ținută în tăcere.' });
movie('m-ro-comedy2', 'ask-main', { title: 'Filantropica', genres: ['Comedy'], year: 2002, min: 110, lang: 'rum' });
movie('m-en-comedy', 'ask-main', { title: 'Short Laughs', genres: ['Comedy'], year: 2015, min: 85 });
movie('m-en-comedy-r', 'ask-main', { title: 'Raunchy', genres: ['Comedy'], year: 2016, min: 80, cr: 'R' });
movie('m-secret-comedy', 'ask-secret', { title: 'Hidden Gem', genres: ['Comedy'], year: 2005, min: 80, lang: 'rum' });
movie('m-heist', 'ask-main', { title: 'The Vault', genres: ['Crime', 'Thriller'], year: 2017, overview: 'A crew of thieves in red jumpsuits and masks takes over the national mint.' });
movie('m-inception', 'ask-main', { title: 'Inception', genres: ['Action', 'Science Fiction'], year: 2010, min: 148, rating: 8.4 });
movie('m-light-scifi', 'ask-main', { title: 'Galaxy Laughs', genres: ['Science Fiction', 'Comedy'], year: 2012 });
movie('m-dark-scifi', 'ask-main', { title: 'Dark Orbit', genres: ['Science Fiction', 'Horror'], year: 2012 });
movie('m-hanks', 'ask-main', { title: 'Big Heart', genres: ['Drama'], year: 1994, people: ['Tom Hanks'] });

const admin = getUser((await createUser({ username: 'ask-admin', password: 'pass1234', isAdmin: true })).id);
const kid = getUser((await createUser({ username: 'ask-kid', password: 'pass1234', libraryIds: ['ask-main'], maxContentRating: 'PG-13' })).id);
db.run('INSERT INTO user_data (user_id, item_id, played) VALUES (?, ?, 1)', kid.id, 'm-en-comedy');
// Registered after the last top-level await: node:test runs root hooks as soon as the tests queued so far finish.
after(() => closeVectorWorker());

const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);

test('Romanian comedies from the 2000s: genre names in any language, decade, spoken language', async () => {
  const r = await ask(admin, { q: 'comedii românești din anii 2000' });
  assert.deepEqual(new Set(ids(r)), new Set(['m-ro-comedy', 'm-ro-comedy2', 'm-secret-comedy']));
  assert.equal(r.by, 'rules');
  assert.deepEqual(r.chips.map((c) => c.label), ['Comedy', '2000s', 'Romanian']);
});

test('access control: hidden libraries and over-rated titles never appear; watched state is per user', async () => {
  const r = await ask(kid, { q: 'funny movies under 90 minutes' });
  assert.ok(!ids(r).includes('m-secret-comedy'), 'no access to that library');
  assert.ok(!ids(r).includes('m-en-comedy-r'), 'over the rating limit');
  assert.deepEqual(new Set(ids(r)), new Set(['m-ro-comedy', 'm-en-comedy']));
  const unseen = await ask(kid, { q: "something funny under 90 minutes we haven't seen" });
  assert.deepEqual(ids(unseen), ['m-ro-comedy']);
  const adminUnseen = await ask(admin, { q: "something funny under 90 minutes we haven't seen" });
  assert.ok(ids(adminUnseen).includes('m-en-comedy'), "another user's watched state doesn't apply");
  // A crafted filter can't widen access either.
  const crafted = await ask(kid, { q: 'x', filter: { genres: ['Comedy'], types: ['movie'] } });
  assert.ok(!ids(crafted).includes('m-secret-comedy') && !ids(crafted).includes('m-en-comedy-r'));
  // "like <title>" only resolves titles the viewer can see.
  const likeHidden = await ask(kid, { q: 'like Hidden Gem' });
  assert.equal(likeHidden.likeItem, null);
});

test('like <title> but lighter: same-genre titles first, darker ones pushed down, the title itself excluded', async () => {
  const r = await ask(admin, { q: 'like Inception but lighter' });
  assert.equal(r.likeItem?.id, 'm-inception');
  assert.ok(!ids(r).includes('m-inception'));
  assert.ok(!ids(r).includes('m-dark-scifi'), 'lighter excludes horror');
  assert.equal(ids(r)[0], 'm-light-scifi');
});

test('keywords find plots; people and removing chips work', async () => {
  const r = await ask(admin, { q: 'that heist film with red jumpsuits' });
  assert.equal(ids(r)[0], 'm-heist');
  const hanks = await ask(admin, { q: 'movies with Tom Hanks from the 90s' });
  assert.deepEqual(ids(hanks), ['m-hanks']);
  const widened = await ask(admin, { q: 'movies with Tom Hanks from the 90s', filter: hanks.filter, remove: ['years', 'people:Tom Hanks'] });
  assert.ok(ids(widened).length > 5);
  assert.deepEqual(widened.chips.map((c) => c.key), ['types']);
});

test('the language model understands what the rules cannot; an invalid reply falls back to the rules', async () => {
  clearAskCache();
  const r = await ask(admin, { q: 'the one where robbers wear Dali masks' }, { chat: async () => '{"genres":["Crime"],"keywords":["robbery","masks"],"titles":["The Vault"]}' });
  assert.equal(r.by, 'llm');
  assert.equal(ids(r)[0], 'm-heist');
  clearAskCache();
  const bad = await ask(admin, { q: 'romanian comedies from the 2000s, the cosy kind' }, { chat: async () => 'not json at all' });
  assert.equal(bad.by, 'rules');
  assert.ok(ids(bad).includes('m-ro-comedy'));
});

test('semantic ranking with stored vectors (fake embedder), still filtered by access', async () => {
  updateSettings({ ai: { ...getSettings().ai!, ask: { embeddings: true, embeddingSource: 'local', embeddingModel: null } } });
  const v = (x: number, y: number, z: number) => Float32Array.from([x, y, z]);
  storeVector('m-heist', 'minilm-l6-v2', 'h1', v(1, 0, 0));
  storeVector('m-secret-comedy', 'minilm-l6-v2', 'h2', v(0.99, 0.1, 0));
  storeVector('m-hanks', 'minilm-l6-v2', 'h3', v(0, 1, 0));
  storeVector('m-inception', 'minilm-l6-v2', 'h4', v(0, 0, 1));
  const r = await ask(kid, { q: 'people stealing gold bars' }, { embed: async () => [v(1, 0.05, 0)] });
  assert.equal(r.semantic, true);
  assert.equal(ids(r)[0], 'm-heist');
  assert.ok(!ids(r).includes('m-secret-comedy'), 'semantic neighbours outside the viewer\'s libraries are dropped');
  updateSettings({ ai: { ...getSettings().ai!, ask: { embeddings: false, embeddingSource: 'local', embeddingModel: null } } });
});

test('speed: p95 well under 300 ms on 20,000 movies without a language model', async () => {
  lib('ask-big');
  const genres = [['Comedy'], ['Drama'], ['Action', 'Thriller'], ['Comedie'], ['Horror'], ['Science Fiction']];
  db.tx(() => {
    for (let i = 0; i < 20000; i++) {
      db.insert('items', { id: `big${i}`, library_id: 'ask-big', type: 'movie', title: `Film ${i}`, sort_title: `Film ${i}`, year: 1970 + (i % 55), duration_ms: (75 + (i % 90)) * 60000, genres: JSON.stringify(genres[i % 6]), community_rating: (i % 90) / 10, content_rating: 'PG', overview: `A story number ${i} about ${i % 3 ? 'love' : 'a heist'} in a small town.`, added_at: now, updated_at: now });
    }
  });
  const queries = ["something funny under 90 minutes we haven't seen", 'romanian comedies from the 2000s', 'highly rated sci-fi after 2015', 'that heist film with red jumpsuits', 'filme de groază din anii 80', 'like Inception but lighter'];
  const times: number[] = [];
  for (let k = 0; k < 30; k++) {
    const t = performance.now();
    await ask(admin, { q: queries[k % queries.length] });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`# Ask p95 on 20k movies: ${p95.toFixed(1)} ms (median ${times[15].toFixed(1)} ms)`);
  assert.ok(p95 < 300, `p95 ${p95} ms`);
});

test('local embeddings: BERT WordPiece tokenisation and mean pooling', async () => {
  const { WordPiece, meanPool } = await import('../src/services/ask/embed.ts');
  const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'the', 'heist', 'film', 'red', 'jump', '##suit', '##s', ',', 'cafe'].join('\n');
  const wp = new WordPiece(vocab, 16);
  // Lower-cased, accents stripped ("Café" → "cafe"), punctuation split, sub-words with ##, unknown words → [UNK].
  assert.deepEqual(wp.encode('The HEIST film, red jumpsuits Café zzz'), [2, 4, 5, 6, 11, 7, 8, 9, 10, 12, 1, 3]);
  assert.equal(wp.encode('the '.repeat(40)).length, 16, 'truncated to the model length with [SEP] last');
  assert.deepEqual(Array.from(meanPool(Float32Array.from([1, 2, 3, 4]), 2, 2)), [2, 3]);
});
