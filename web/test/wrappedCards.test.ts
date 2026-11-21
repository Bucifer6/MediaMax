// Wrapped story cards built from the story data (run: npm test -w web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WrappedStory } from '@mediamax/shared';
import { buildCards, hoursLabel, tintColors } from '../src/wrapped/cards.ts';

const entry = (title: string, minutes: number, extra: Partial<WrappedStory['topTitles'][0]> = {}) => ({ itemId: title, title, subtitle: null, posterUrl: `/api/v1/images/${title}`, plays: 1, minutes, ...extra });
const story: WrappedStory = {
  year: 2025, displayName: 'Robin', totalMinutes: 6000, totalPlays: 120, activeDays: 90, moviesWatched: 20, episodesWatched: 60, tracksPlayed: 40, longestStreakDays: 9,
  topTitles: [entry('Box Set', 1200, { subtitle: 'Series' }), entry('Space Saga', 130, { subtitle: 'Movie' })],
  topGenres: [{ genre: 'Drama', minutes: 2000 }, { genre: 'Comedy', minutes: 900 }],
  topPeople: [{ name: 'Ava Star', kind: 'actor', imageUrl: null, minutes: 300, titles: 3 }],
  binge: { showId: 's', title: 'Box Set', posterUrl: null, episodes: 7, minutes: 315, date: '2025-03-14' },
  biggestDay: { date: '2025-03-14', minutes: 315 },
  personality: { id: 'drama-devotee', title: 'The Drama Devotee', description: 'Big performances.', traits: ['Night owl', 'Binge-watcher'] },
  heatmap: Array.from({ length: 12 }, (_, m) => Array.from({ length: 28 }, (_, d) => (m === 2 && d === 13 ? 315 : 0))),
  minutesByMonth: [0, 0, 315, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  topArtists: [entry('Synth Band', 60)], topTracks: [entry('Glow', 8, { subtitle: 'Synth Band', plays: 2 })], musicMinutes: 60, peakHour: 22,
};

test('a full year: every card in story order, with the right numbers', () => {
  const cards = buildCards(story, 'My Server');
  assert.deepEqual(cards.map((c) => c.kind), ['intro', 'total', 'titles', 'genres', 'people', 'binge', 'personality', 'heatmap', 'music', 'outro']);
  assert.equal(cards[0].eyebrow, 'My Server Wrapped');
  assert.equal(cards[0].big, '2025');
  const total = cards[1];
  assert.deepEqual([total.big, total.bigUnit], ['100', 'hours']);
  assert.match(total.sub!, /120 plays across 90 days · 9-day streak/);
  assert.equal(cards[2].headline, 'Box Set');
  assert.equal(cards[2].image, '/api/v1/images/Box Set');
  assert.equal(cards[2].list!.length, 2);
  assert.deepEqual([cards[5].big, cards[5].bigUnit, cards[5].headline], ['7', 'episodes', 'of Box Set in one day']);
  assert.match(cards[5].sub!, /March 14, 2025/);
  assert.equal(cards[6].headline, 'The Drama Devotee');
  assert.deepEqual(cards[6].traits, ['Night owl', 'Binge-watcher']);
  assert.equal(cards[7].headline, 'March was your biggest month');
  assert.equal(cards[8].headline, 'Synth Band');
  assert.ok(cards.every((c) => !JSON.stringify(c).includes('Kinora')), 'product name comes from the branding, never hard-coded');
});

test('missing sections are skipped; empty history is two cards', () => {
  const thin = buildCards({ ...story, topPeople: [], binge: null, topArtists: [], topTracks: [], heatmap: [], year: null }, 'X');
  assert.deepEqual(thin.map((c) => c.kind), ['intro', 'total', 'titles', 'genres', 'personality', 'outro']);
  assert.equal(thin[0].big, 'All time');
  const empty = buildCards({ ...story, totalMinutes: 0, topTitles: [] }, 'X');
  assert.deepEqual(empty.map((c) => c.kind), ['intro', 'outro']);
});

test('hours label and artwork tint', () => {
  assert.deepEqual(hoursLabel(45), { value: '45', unit: 'minutes' });
  assert.deepEqual(hoursLabel(60), { value: '1', unit: 'hour' });
  assert.deepEqual(hoursLabel(90), { value: '1.5', unit: 'hours' });
  assert.deepEqual(hoursLabel(60 * 1234), { value: '1,234', unit: 'hours' });
  const red = tintColors([200, 30, 30], 100);
  assert.match(red.from, /^hsl\(0 /);
  const fallback = tintColors(null, 200);
  assert.equal(fallback.from, 'hsl(200 70% 32%)');
});
