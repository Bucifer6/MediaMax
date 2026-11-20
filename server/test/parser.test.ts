import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMovieName, parseEpisodeName, parseSeasonFolder, parseShowFolder, isExtra, parseSubtitleName } from '../src/services/parser.ts';

test('movie names', () => {
  assert.deepEqual(parseMovieName('Inception (2010).mkv').title, 'Inception');
  assert.equal(parseMovieName('Inception (2010).mkv').year, 2010);
  const scene = parseMovieName('The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv');
  assert.equal(scene.title, 'The Matrix');
  assert.equal(scene.year, 1999);
  assert.equal(parseMovieName('Blade Runner 2049 (2017) [tmdbid-335984].mkv').tmdbId, '335984');
  assert.equal(parseMovieName('Blade Runner 2049 (2017) [tmdbid-335984].mkv').title, 'Blade Runner 2049');
  assert.equal(parseMovieName('Some Film tt0111161.mp4').imdbId, 'tt0111161');
  assert.equal(parseMovieName('Untitled Home Movie.mp4').year, null);
});

test('episode names', () => {
  const e = parseEpisodeName('Breaking.Bad.S02E05.Breakage.720p.mkv');
  assert.equal(e.season, 2);
  assert.equal(e.episode, 5);
  assert.equal(e.show, 'Breaking Bad');
  assert.equal(e.title, 'Breakage');
  const multi = parseEpisodeName('Show - S01E01E02 - Double.mkv');
  assert.equal(multi.episode, 1);
  assert.equal(multi.episodeEnd, 2);
  const x = parseEpisodeName('Friends 3x07.avi');
  assert.deepEqual([x.season, x.episode], [3, 7]);
  const daily = parseEpisodeName('The Daily Show 2024-03-01.mkv');
  assert.equal(daily.airDate, '2024-03-01');
  assert.equal(parseEpisodeName('05 - The Fifth One.mkv').episode, 5);
});

test('season and show folders', () => {
  assert.equal(parseSeasonFolder('Season 01'), 1);
  assert.equal(parseSeasonFolder('S3'), 3);
  assert.equal(parseSeasonFolder('Specials'), 0);
  assert.equal(parseSeasonFolder('Random'), null);
  assert.deepEqual(parseShowFolder('The Office (US) (2005)').year, 2005);
  assert.equal(parseShowFolder('Doctor Who (2005) [tvdbid-78804]').tvdbId, '78804');
});

test('extras and subtitles', () => {
  assert.ok(isExtra('Movie (2010)/Extras/behind.mkv'));
  assert.ok(isExtra('Movie (2010)/movie-sample.mkv'));
  assert.ok(!isExtra('Movie (2010)/Movie (2010).mkv'));
  assert.deepEqual(parseSubtitleName('Movie.en.forced.srt', 'Movie'), { language: 'en', forced: true, default: false, title: null });
  assert.equal(parseSubtitleName('Other.en.srt', 'Movie'), null);
});
