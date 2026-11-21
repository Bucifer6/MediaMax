import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
process.env.MEDIAMAX_DATA ??= os.tmpdir() + '/mediamax-subp-' + process.pid;

const { cleanSubtitle, detectEncoding, decodeAs, fixRomanianDiacritics, fixRomanianMojibake, fixDoubleUtf8, stripSrtAdverts, isAdvertLine } = await import('../src/services/subtitleProviders/cleanup.ts');
const { parseRelease, scoreRelease } = await import('../src/services/subtitleProviders/release.ts');
const { archiveKind, extractArchive, pickSubtitleFile } = await import('../src/services/subtitleProviders/archive.ts');
const { createZip } = await import('../src/util/zip.ts');
const { searchProviders, fetchProcessed } = await import('../src/services/subtitleProviders/index.ts');
const { createSubsRoProvider, mapSubsRoItem } = await import('../src/services/subtitleProviders/subsro.ts');
const { openSubtitlesParams } = await import('../src/services/subtitleProviders/opensubtitles.ts');
const { normaliseSubtitles, DEFAULT_SETTINGS, SECRET_MASK } = await import('../src/services/settings.ts');
const { lang2 } = await import('../src/services/subtitleProviders/lang.ts');
type SubtitleProvider = import('../src/services/subtitleProviders/types.ts').SubtitleProvider;
type SubtitleQuery = import('../src/services/subtitleProviders/types.ts').SubtitleQuery;

const SRT = (lines: string[]) => lines.map((t, i) => `${i + 1}\r\n00:00:0${i},000 --> 00:00:0${i},900\r\n${t}\r\n`).join('\r\n');

/* ------------------------------ encoding ------------------------------ */

test('UTF-8 and UTF-8 BOM are detected and the BOM is dropped', () => {
  const text = 'Ce faci? Mergem acasă, ți-am spus.';
  assert.equal(detectEncoding(Buffer.from(text, 'utf8'), 'ro'), 'utf-8');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  assert.equal(detectEncoding(bom, 'ro'), 'utf-8-bom');
  assert.equal(cleanSubtitle(bom, 'ro').text, text);
});

test('Windows-1250 Romanian (cedilla bytes) decodes and becomes comma-below UTF-8', () => {
  // "Şi ţie îţi spun: aşa e." in cp1250, with a cp1250-only quote (0x84 „) that is a C1 control in ISO-8859-2.
  const bytes = Buffer.from([0xaa, 0x69, 0x20, 0xfe, 0x69, 0x65, 0x20, 0xee, 0xfe, 0x69, 0x20, 0x73, 0x70, 0x75, 0x6e, 0x3a, 0x20, 0x84, 0x61, 0xba, 0x61, 0x20, 0x65, 0x2e, 0x94]);
  assert.equal(detectEncoding(bytes, 'ro'), 'windows-1250');
  const r = cleanSubtitle(bytes, 'ro');
  assert.equal(r.text, 'Și ție îți spun: „așa e.”');
  assert.ok(r.fixes.some((f) => /windows-1250/.test(f)));
});

test('ISO-8859-2 and ISO-8859-16 Romanian decode to the same text', () => {
  // "mâine ştiu, ţară" — ş=0xBA ţ=0xFE in ISO-8859-2 (cedilla), ș=0xBA ț=0xFE in ISO-8859-16 (comma-below).
  const bytes = Buffer.from([0x6d, 0xe2, 0x69, 0x6e, 0x65, 0x20, 0xba, 0x74, 0x69, 0x75, 0x2c, 0x20, 0xfe, 0x61, 0x72, 0xe3]);
  assert.equal(decodeAs(bytes, 'iso-8859-2'), 'mâine ştiu, ţară');
  assert.equal(decodeAs(bytes, 'iso-8859-16'), 'mâine știu, țară');
  const enc = detectEncoding(bytes, 'ro');
  assert.ok(['windows-1250', 'iso-8859-16', 'iso-8859-2'].includes(enc), enc);
  assert.equal(cleanSubtitle(bytes, 'ro').text, 'mâine știu, țară');
  // ISO-8859-16 specific letters (Ș 0xAA, Ț 0xDE) and the euro sign at 0xA4.
  assert.equal(decodeAs(Buffer.from([0xaa, 0xde, 0xa4]), 'iso-8859-16'), 'ȘȚ€');
});

test('Western text without a Romanian hint stays Windows-1252', () => {
  const text = 'Café crème, très bien, à bientôt, garçon';
  const bytes = Buffer.from(text, 'latin1');
  assert.equal(detectEncoding(bytes, 'fr'), 'windows-1252');
  assert.equal(cleanSubtitle(bytes, 'fr').text, text);
  assert.equal(detectEncoding(bytes, null), 'windows-1252');
});

test('cedilla → comma-below only for Romanian', () => {
  assert.equal(fixRomanianDiacritics('ş Ş ţ Ţ'), 'ș Ș ț Ț');
  const turkish = Buffer.from('Teşekkür ederim, şimdi', 'utf8');
  assert.equal(cleanSubtitle(turkish, 'tr').text, 'Teşekkür ederim, şimdi');
  assert.equal(cleanSubtitle(Buffer.from('aşa', 'utf8'), 'rum').text, 'așa');
});

test('Romanian cp1250-read-as-cp1252 mojibake is repaired only when it is clearly there', () => {
  const broken = 'Nu ºtiu de ce eºti aºa. Pentru cã þara e mare. ªi Þie.';
  assert.equal(fixRomanianMojibake(broken), 'Nu știu de ce ești așa. Pentru că țara e mare. Și Ție.');
  // One stray º (an ordinal) is not damage.
  assert.equal(fixRomanianMojibake('Capitolul 1º, mâine.'), 'Capitolul 1º, mâine.');
  // Real diacritics present → leave alone.
  assert.equal(fixRomanianMojibake('știu ºtiu ºtiu ºtiu știu știu'), 'știu ºtiu ºtiu ºtiu știu știu');
  // Through the pipeline: a UTF-8 file carrying the mojibake, language ro.
  assert.equal(cleanSubtitle(Buffer.from(broken, 'utf8'), 'ro').text, 'Nu știu de ce ești așa. Pentru că țara e mare. Și Ție.');
  // Not applied to Portuguese ("não", "irmã").
  assert.equal(cleanSubtitle(Buffer.from('não, irmã, ºtiu ºtiu ºtiu', 'utf8'), 'pt').text, 'não, irmã, ºtiu ºtiu ºtiu');
});

test('double-encoded UTF-8 (UTF-8 read as cp1252) is undone', () => {
  const good = 'Și ăsta e un țânțar în casă.';
  const broken = new TextDecoder('windows-1252').decode(Buffer.from(good, 'utf8'));
  assert.notEqual(broken, good);
  assert.equal(fixDoubleUtf8(broken), good);
  assert.equal(fixDoubleUtf8('Ã la carte'), 'Ã la carte');
});

test('line endings are normalised and advert cues stripped conservatively', () => {
  const srt = SRT(['<font color="#ffff00">Subtitrarea: www.subs.ro</font>', 'Bună ziua.', 'Vino la www.example.com mâine', 'Downloaded from www.OpenSubtitles.org']);
  const r = cleanSubtitle(Buffer.from(srt, 'utf8'), 'ro');
  assert.ok(!r.text.includes('\r'));
  assert.ok(!/subs\.ro|OpenSubtitles/i.test(r.text));
  // A dialogue line that merely mentions a site is kept.
  assert.ok(r.text.includes('Vino la www.example.com mâine'));
  assert.ok(r.text.startsWith('1\n00:00:01,000 --> 00:00:01,900\nBună ziua.'));
  assert.ok(r.text.includes('2\n00:00:02,000'));
  assert.equal(isAdvertLine('Sincronizare: Ion'), false);
  assert.equal(isAdvertLine('Sync & corrections by honeybunny - www.addic7ed.com'), true);
  assert.equal(stripSrtAdverts('not an srt file\nwww.subs.ro').removed, 0);
});

/* ------------------------------ release scoring ------------------------------ */

test('release parsing: source, resolution, group, season/episode', () => {
  const r = parseRelease('The.Show.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv');
  assert.deepEqual([r.source, r.resolution, r.group, r.season, r.episode], ['web-dl', '1080p', 'NTb', 2, 5]);
  const m = parseRelease('Movie.Name.2019.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-FGT');
  assert.deepEqual([m.source, m.resolution, m.group], ['remux', '2160p', 'FGT']);
  assert.equal(parseRelease('Movie.2010.720p.HDTV.x264-KILLERS.ro.srt').group, 'KILLERS');
  assert.equal(parseRelease('Movie.2010.1080p.WEB-DL.H264').group, null);
  assert.equal(parseRelease('Movie.2010.WEBRip.x264-ION10').source, 'webrip');
  const pack = parseRelease('The.Show.S02.1080p.BluRay.x264-DEMAND');
  assert.deepEqual([pack.season, pack.episode, pack.seasonPack], [2, null, true]);
});

test('scoring: hash > group+source > source > family > nothing; wrong episode is a mismatch', () => {
  const media = parseRelease('The.Show.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv');
  const hash = scoreRelease(media, 'whatever', { hashMatch: true });
  const exact = scoreRelease(media, 'The.Show.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb');
  const sameSource = scoreRelease(media, 'The.Show.S02E05.720p.WEB-DL-OTHER');
  const family = scoreRelease(media, 'The.Show.S02E05.1080p.WEBRip.x264-ION10');
  const other = scoreRelease(media, 'The.Show.S02E05.HDTV.x264-LOL');
  const wrongEp = scoreRelease(media, 'The.Show.S02E06.1080p.WEB-DL-NTb');
  assert.equal(hash.score, 100);
  assert.ok(exact.score >= 80 && exact.score < 100, String(exact.score));
  assert.ok(exact.reasons.includes('same group') && exact.reasons.includes('same source'));
  assert.ok(exact.score > sameSource.score && sameSource.score > other.score);
  assert.ok(family.score > other.score);
  assert.equal(wrongEp.mismatch, true);
  assert.equal(wrongEp.score, 0);
  // Multi-release text: the best variant counts.
  assert.equal(scoreRelease(media, 'The.Show.S02E05.HDTV-LOL / The.Show.S02E05.1080p.WEB-DL-NTb').score, scoreRelease(media, 'The.Show.S02E05.1080p.WEB-DL-NTb').score);
  // Season pack of the right season is fine, of another season is a mismatch.
  assert.equal(scoreRelease(media, 'The.Show.S02.1080p.WEB-DL-NTb').mismatch, false);
  assert.equal(scoreRelease(media, 'The.Show.S03.1080p.WEB-DL-NTb').mismatch, true);
  // Machine translation costs points.
  assert.equal(scoreRelease(media, 'The.Show.S02E05.1080p.WEB-DL-NTb', { aiTranslated: true }).score, scoreRelease(media, 'The.Show.S02E05.1080p.WEB-DL-NTb').score - 20);
});

/* ------------------------------ archives ------------------------------ */

test('season pack: the right SxxEyy file is picked from an in-memory zip; junk is ignored', async () => {
  const zip = createZip([
    { name: 'Show.S01.WEB-DL-NTb/readme.txt', data: 'visit our site' },
    { name: 'Show.S01.WEB-DL-NTb/Show.S01E01.WEB-DL-NTb.srt', data: SRT(['one']) },
    { name: 'Show.S01.WEB-DL-NTb/Show.S01E02.WEB-DL-NTb.srt', data: SRT(['two']) },
    { name: 'Show.S01.WEB-DL-NTb/Show.S01E03.WEB-DL-NTb.srt', data: SRT(['three']) },
    { name: '__MACOSX/._Show.S01E02.WEB-DL-NTb.srt', data: 'junk' },
    { name: 'Show.S01.WEB-DL-NTb/cover.jpg', data: Buffer.alloc(100, 1) },
  ]);
  assert.equal(archiveKind(zip), 'zip');
  const entries = await extractArchive(zip, 'zip');
  const pick = pickSubtitleFile(entries, { season: 1, episode: 2 });
  assert.equal(pick?.name, 'Show.S01.WEB-DL-NTb/Show.S01E02.WEB-DL-NTb.srt');
  assert.equal(pickSubtitleFile(entries, { season: 1, episode: 9 }), null, 'never a wrong episode');
  // Movie: one subtitle among junk.
  const movie = await extractArchive(createZip([{ name: 'Movie.2010.BluRay-X.srt', data: SRT(['hi']) }, { name: 'subs.ro.url', data: 'x' }]), 'zip');
  assert.equal(pickSubtitleFile(movie, {})?.name, 'Movie.2010.BluRay-X.srt');
  // Several versions of one movie: best release match wins.
  const versions = await extractArchive(createZip([
    { name: 'Movie.2010.720p.HDTV-AAA.srt', data: SRT(['a']) },
    { name: 'Movie.2010.1080p.BluRay.x264-SPARKS.srt', data: SRT(['b']) },
  ]), 'zip');
  assert.equal(pickSubtitleFile(versions, { media: parseRelease('Movie.2010.1080p.BluRay.x264-SPARKS.mkv') })?.name, 'Movie.2010.1080p.BluRay.x264-SPARKS.srt');
  assert.equal(archiveKind(Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1')), 'rar');
  assert.equal(archiveKind(Buffer.from(SRT(['x']))), null);
});

/* ------------------------------ fan-out / merge ------------------------------ */

const query = (over: Partial<SubtitleQuery> = {}): SubtitleQuery => ({
  item: { id: 'i1', type: 'episode', title: 'Pilot', year: 2020 }, media: null, languages: ['ro'], imdbId: null, tmdbId: null,
  showImdbId: 'tt1234567', showTmdbId: '99', showTitle: 'The Show', season: 2, episode: 5, title: 'The Show', year: 2020,
  releaseName: 'The.Show.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv', movieHash: null, ...over,
});

const stub = (id: string, results: any[] | Error, delay = 0): SubtitleProvider => ({
  id, name: id.toUpperCase(),
  search: async () => {
    await new Promise((r) => setTimeout(r, delay));
    if (results instanceof Error) throw results;
    return results;
  },
  download: async (r) => ({ data: Buffer.from(SRT([`from ${id} ${r.id}`])), fileName: `${r.id}.srt` }),
});

test('fan-out merges providers, scores, sorts by score then priority then downloads', async () => {
  const a = stub('a', [
    { id: '1', language: 'ro', release: 'The.Show.S02E05.HDTV-LOL', downloads: 900 },
    { id: '2', language: 'ro', release: 'The.Show.S02E05.1080p.WEB-DL-NTb', downloads: 5 },
    { id: '2', language: 'ro', release: 'duplicate id dropped' },
  ], 20);
  const b = stub('b', [
    { id: 'x', language: 'rum', release: 'The.Show.S02E05.1080p.WEB-DL-NTb', downloads: 1 },
    { id: 'y', language: 'ro', release: 'The.Show.S02E06.1080p.WEB-DL-NTb', downloads: 10000 },
  ]);
  const out = await searchProviders([a, b], query());
  assert.deepEqual(out.map((r) => `${r.remote.provider}:${r.remote.fileId}`), ['a:2', 'b:x', 'a:1', 'b:y']);
  assert.equal(out[1].remote.language, 'ro', 'language normalised');
  assert.equal(out[1].remote.providerName, 'B');
  assert.ok((out[0].remote.score ?? 0) > (out[2].remote.score ?? 0));
  assert.equal(out[3].mismatch, true);
});

test('fan-out: one failing provider is tolerated, all failing rethrows the first error', async () => {
  const ok = stub('ok', [{ id: '1', language: 'ro', release: 'x' }]);
  const bad = stub('bad', new Error('boom'));
  assert.equal((await searchProviders([bad, ok], query())).length, 1);
  await assert.rejects(searchProviders([bad, stub('bad2', new Error('second'))], query()), /boom/);
});

test('download pipeline: zip season pack from a provider → right episode, UTF-8, comma diacritics', async () => {
  const cp1250 = Buffer.concat([Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\n', 'latin1'), Buffer.from([0xaa, 0x69, 0x20, 0xfe, 0x69, 0x65, 0x84, 0x94]), Buffer.from('\r\n', 'latin1')]);
  const provider: SubtitleProvider = {
    id: 'p', name: 'P', search: async () => [],
    download: async () => ({ data: createZip([{ name: 'S02E04.srt', data: SRT(['wrong']) }, { name: 'The.Show.S02E05.srt', data: cp1250 }]), fileName: 'pack.zip' }),
  };
  const r = await fetchProcessed(provider, { id: '1', language: 'ro', release: null }, { season: 2, episode: 5, releaseName: null });
  assert.equal(r.ext, 'srt');
  assert.equal(r.data.toString('utf8'), '1\n00:00:01,000 --> 00:00:02,000\nȘi ție„”\n');
  await assert.rejects(fetchProcessed(provider, { id: '1', language: 'ro', release: null }, { season: 2, episode: 9, releaseName: null }), /no subtitle file for S02E09/);
});

/* ------------------------------ Subs.ro ------------------------------ */

test('Subs.ro provider against a stub HTTP server (configurable base URL)', async () => {
  const seen: { url: string; key: string | undefined }[] = [];
  const zip = createZip([{ name: 'Movie.2010.1080p.BluRay-SPARKS.srt', data: Buffer.from([0x31, 0x0a, 0x30, 0x30, 0x3a, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2c, 0x30, 0x30, 0x30, 0x20, 0x2d, 0x2d, 0x3e, 0x20, 0x30, 0x30, 0x3a, 0x30, 0x30, 0x3a, 0x30, 0x32, 0x2c, 0x30, 0x30, 0x30, 0x0a, 0x61, 0xba, 0x61, 0x0a]) }]);
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url!, key: req.headers['x-subs-api-key'] as string | undefined });
    if (req.headers['x-subs-api-key'] !== 'k3y') {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/v1.0/search/imdbid/tt0000001') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        status: 200,
        items: [
          { id: 101, title: 'Movie (2010)', description: 'Movie.2010.1080p.BluRay.x264-SPARKS', language: 'ro', downloads: 42 },
          { id: 102, title: 'Movie (2010)', release: 'Movie.2010.720p.WEB-DL-AAA', language: 'en' },
          { id: 103, title: 'Movie (2010)', release: 'Movie.2010.DVDRip', language: 'rum', type: 'rar' },
          { title: 'no id → skipped' },
        ],
      }));
      return;
    }
    if (req.url === '/v1.0/search/title/Unknown%20Film') {
      res.writeHead(404).end();
      return;
    }
    if (req.url === '/v1.0/subtitle/101/download') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="movie-ro.zip"' }).end(zip);
      return;
    }
    res.writeHead(500).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1.0/`;
  try {
    const p = createSubsRoProvider(() => ({ apiKey: 'k3y', baseUrl: base }));
    assert.equal(p.configured!(), true);
    const q = query({ item: { id: 'm', type: 'movie', title: 'Movie', year: 2010 }, imdbId: 'tt0000001', season: null, episode: null, languages: ['ro'], releaseName: 'Movie.2010.1080p.BluRay.x264-SPARKS.mkv' });
    const results = await p.search(q);
    assert.deepEqual(results.map((r) => [r.id, r.language]), [['101', 'ro'], ['103', 'ro']]);
    assert.equal(results[0].release, 'Movie.2010.1080p.BluRay.x264-SPARKS');
    assert.equal(results[0].downloads, 42);
    assert.equal(results[1].archive, 'rar');
    assert.deepEqual(await p.search({ ...q, imdbId: null, tmdbId: null, title: 'Unknown Film' }), []);
    // Through the registry: scored, the exact release first.
    const merged = await searchProviders([p], q);
    assert.equal(merged[0].remote.fileId, '101');
    assert.ok((merged[0].remote.score ?? 0) >= 80);
    // Download → zip → UTF-8 with comma-below.
    const file = await p.download(results[0]);
    assert.equal(file.fileName, 'movie-ro.zip');
    const processed = await fetchProcessed(p, results[0], { season: null, episode: null, releaseName: q.releaseName });
    assert.equal(processed.data.toString('utf8'), '1\n00:00:01,000 --> 00:00:02,000\nașa\n');
    assert.ok(seen.every((s) => s.key === 'k3y'));
    // Wrong key → clear provider error.
    const badKey = createSubsRoProvider(() => ({ apiKey: 'nope', baseUrl: base }));
    await assert.rejects(badKey.search(q), /rejected the API key/);
    assert.equal(createSubsRoProvider(() => ({ apiKey: null, baseUrl: base })).configured!(), false);
  } finally {
    server.close();
  }
});

test('Subs.ro item mapping tolerates alternative field names', () => {
  assert.deepEqual(mapSubsRoItem({ subtitleId: 'ab-1', name: 'X', comment: 'X.S01.WEB', lang: 'romanian', downloadCount: '7' })?.language, 'ro');
  assert.equal(mapSubsRoItem({ id: '../etc' }), null);
  assert.equal(lang2('rum'), 'ro');
  assert.equal(lang2('pt-BR'), 'pt');
});

/* ------------------------------ OpenSubtitles + settings ------------------------------ */

test('OpenSubtitles parameters are unchanged by the provider refactor', () => {
  const ep = openSubtitlesParams(query({ languages: ['ro', 'en'], movieHash: 'abc' }));
  assert.equal(ep.toString(), 'languages=en%2Cro&parent_tmdb_id=99&season_number=2&episode_number=5&moviehash=abc');
  const movie = openSubtitlesParams(query({ item: { id: 'm', type: 'movie', title: 'Movie', year: 2010 }, imdbId: 'tt0133093', tmdbId: null, languages: ['en'] }));
  assert.equal(movie.toString(), 'languages=en&imdb_id=0133093');
  const byTitle = openSubtitlesParams(query({ item: { id: 'm', type: 'movie', title: 'Movie', year: 2010 }, imdbId: null, tmdbId: null, languages: ['EN'] }));
  assert.equal(byTitle.toString(), 'languages=en&query=Movie&year=2010');
});

test('subtitle settings: masked Subs.ro key is kept, providers de-duplicated, numbers clamped', () => {
  const cur = { ...DEFAULT_SETTINGS.subtitles!, subsRo: { apiKey: 'secret', baseUrl: 'https://api.subs.ro/v1.0' } };
  const next = normaliseSubtitles(cur, { subsRo: { apiKey: SECRET_MASK, baseUrl: 'http://127.0.0.1:9/v2/' }, providers: [{ id: 'subsro', enabled: true }, { id: 'subsro', enabled: false }], minScore: 250, languages: ['RO', 'xx-yy-zz', 'en'] });
  assert.equal(next.subsRo.apiKey, 'secret');
  assert.equal(next.subsRo.baseUrl, 'http://127.0.0.1:9/v2');
  assert.deepEqual(next.providers, [{ id: 'subsro', enabled: true }, { id: 'opensubtitles', enabled: true }]);
  assert.equal(next.minScore, 100);
  assert.deepEqual(next.languages, ['ro', 'en']);
  assert.equal(normaliseSubtitles(cur, { subsRo: { apiKey: '', baseUrl: 'javascript:alert(1)' } }).subsRo.baseUrl, 'https://api.subs.ro/v1.0');
});

/* ------------------------------ storage ------------------------------ */

test('saving: data folder keeps the OpenSubtitles naming; sidecars never overwrite the admin’s files and can be deleted', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { db } = await import('../src/db.ts');
  const { saveSubtitle, refreshMediaSubs, deleteDownloadedSubtitle, subtitlesDir } = await import('../src/services/subtitleProviders/storage.ts');
  const { buildQuery } = await import('../src/services/subtitleProviders/index.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-subsave-'));
  const video = path.join(dir, 'The.Show.S02E05.1080p.WEB-DL-NTb.mkv');
  fs.writeFileSync(video, 'x');
  fs.writeFileSync(path.join(dir, 'The.Show.S02E05.1080p.WEB-DL-NTb.ro.srt'), SRT(['admin file']));
  const now = new Date().toISOString();
  db.run('INSERT INTO items (id, type, title, sort_title, added_at, updated_at, external_ids) VALUES (?,?,?,?,?,?,?)', 'show-1', 'show', 'The Show', 'show', now, now, '{"imdb":"tt7654321","tmdb":"77"}');
  db.run('INSERT INTO items (id, type, title, sort_title, added_at, updated_at, grandparent_id, parent_idx, idx) VALUES (?,?,?,?,?,?,?,?,?)', 'ep-1', 'episode', 'Pilot', 'pilot', now, now, 'show-1', 2, 5);
  db.run('INSERT INTO media (id, item_id, path, subs) VALUES (?,?,?,?)', 'media-1', 'ep-1', video, JSON.stringify([{ index: 2, codec: 'subrip', language: 'eng', title: null, default: false, forced: false, external: false }]));

  const q = buildQuery('ep-1', ['RO']);
  assert.deepEqual([q.showImdbId, q.showTmdbId, q.title, q.season, q.episode, q.releaseName, q.languages], ['tt7654321', '77', 'The Show', 2, 5, 'The.Show.S02E05.1080p.WEB-DL-NTb.mkv', ['ro']]);

  const base = { mediaId: 'media-1', videoPath: video, ext: 'srt' as const, flag: 'std' as const, release: null, score: 80, synced: false };
  const os1 = saveSubtitle({ ...base, data: Buffer.from(SRT(['os'])), language: 'en', provider: 'opensubtitles', fileId: '123', mode: 'data' });
  assert.equal(os1, path.join(subtitlesDir('media-1'), 'en.std.123.srt'));
  const side = saveSubtitle({ ...base, data: Buffer.from(SRT(['subsro'])), language: 'ro', provider: 'subsro', fileId: '101', mode: 'sidecar' });
  assert.equal(path.basename(side), 'The.Show.S02E05.1080p.WEB-DL-NTb.ro.subsro.srt');
  assert.equal(fs.readFileSync(path.join(dir, 'The.Show.S02E05.1080p.WEB-DL-NTb.ro.srt'), 'utf8'), SRT(['admin file']));
  refreshMediaSubs('media-1');
  const subs = JSON.parse(db.get<{ subs: string }>('SELECT subs FROM media WHERE id = ?', 'media-1')!.subs) as { index: number; title: string | null; language: string }[];
  assert.deepEqual(subs.map((s) => [s.index, s.language, s.title]), [[2, 'eng', null], [1000, 'rum', null], [3000, 'rum', 'Subs.ro'], [2000, 'eng', 'OpenSubtitles']]);
  deleteDownloadedSubtitle('media-1', 3000);
  assert.equal(fs.existsSync(side), false);
  assert.throws(() => deleteDownloadedSubtitle('media-1', 1000), /not found/i, 'the admin’s own sidecar is not deletable');
  fs.rmSync(dir, { recursive: true, force: true });
});
