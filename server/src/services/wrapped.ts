/**
 * Data for the animated "Wrapped" story: built only from the requesting user's own play history (no other user's
 * data). Extends the plain statistics (stats.ts) with top titles across movies and shows, the people in them, the
 * binge record, a "film personality", a day-by-day heatmap and top music.
 */
import type { Person, StatsTopEntry, WrappedPerson, WrappedPersonality, WrappedStory } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { getUser, qualifiedName } from './auth.js';
import { imageUrl } from './images.js';
import { userStats } from './stats.js';
import { parseJson } from '../util/misc.js';

const SELECT = `SELECT h.started_at, h.ended_at, h.duration_ms, h.item_id, h.channel_id, i.type itype, i.title ititle, i.duration_ms item_duration,
    i.poster iposter, i.people ipeople, i.grandparent_id, i.parent_id, g.title gtitle, g.poster gposter, g.people gpeople, p.title ptitle, p.poster pposter
  FROM play_history h
  LEFT JOIN items i ON i.id = h.item_id
  LEFT JOIN items p ON p.id = i.parent_id
  LEFT JOIN items g ON g.id = i.grandparent_id`;

/** Same rule as stats.ts: wall-clock session time capped by the runtime. */
function minutesOf(r: Row, now = Date.now()): number {
  let ms = r.duration_ms ?? 0;
  if (!ms && !r.ended_at) ms = Math.max(0, now - Date.parse(r.started_at));
  if (r.item_duration) ms = Math.min(ms, r.item_duration * 1.1);
  return Math.max(0, ms / 60000);
}

function bump(map: Map<string, StatsTopEntry>, key: string, base: Omit<StatsTopEntry, 'plays' | 'minutes'>, minutes: number) {
  const e = map.get(key) ?? { ...base, plays: 0, minutes: 0 };
  e.plays++;
  e.minutes += minutes;
  map.set(key, e);
}
const top = (m: Map<string, StatsTopEntry>, n: number) =>
  [...m.values()].sort((a, b) => b.minutes - a.minutes || b.plays - a.plays).slice(0, n).map((e) => ({ ...e, minutes: Math.round(e.minutes) }));

const GENRE_ARCHETYPES: { match: RegExp; id: string; title: string; description: string }[] = [
  { match: /horror|thriller/i, id: 'thrill-seeker', title: 'The Thrill Seeker', description: 'Lights off, volume up. You live for the jump scare and the twist nobody saw coming.' },
  { match: /comedy/i, id: 'comic-relief', title: 'The Comic Relief', description: 'Life is better with a laugh track. You always know what to put on when the room needs cheering up.' },
  { match: /documentary|history|biography/i, id: 'curious-mind', title: 'The Curious Mind', description: 'Every night is a chance to learn something new — you watch to understand the world.' },
  { match: /science fiction|sci-fi|fantasy/i, id: 'explorer', title: 'The Explorer', description: 'Other worlds, other times. The stranger the universe, the more at home you feel.' },
  { match: /action|adventure|war|western/i, id: 'adrenaline', title: 'The Adrenaline Junkie', description: 'Car chases, heists and last-second escapes — your pulse is the soundtrack.' },
  { match: /animation|family|kids/i, id: 'forever-young', title: 'Forever Young', description: 'Hand-drawn, pixel-perfect or stop-motion: you know the best stories are for everyone.' },
  { match: /romance/i, id: 'romantic', title: 'The Hopeless Romantic', description: 'Meet-cutes, grand gestures, happy endings. You never get tired of a good love story.' },
  { match: /crime|mystery/i, id: 'detective', title: 'The Detective', description: 'You had it figured out before the reveal. Clues, alibis and a good whodunit keep you hooked.' },
  { match: /drama/i, id: 'drama-devotee', title: 'The Drama Devotee', description: 'Big performances and stories that stay with you long after the credits roll.' },
  { match: /music|musical/i, id: 'showstopper', title: 'The Showstopper', description: 'If there is a song in it, you are in. Bonus points for a big finale number.' },
];

/** A light-hearted label from what and how the user watched. Deterministic for the same inputs. */
export function filmPersonality(input: {
  topGenre: string | null; peakHour: number | null; bingeEpisodes: number; movies: number; episodes: number; musicShare: number; streak: number; totalMinutes: number;
}): WrappedPersonality {
  const traits: string[] = [];
  if (input.peakHour != null && (input.peakHour >= 22 || input.peakHour < 4)) traits.push('Night owl');
  else if (input.peakHour != null && input.peakHour < 10) traits.push('Early bird');
  else if (input.peakHour != null) traits.push('Prime-time regular');
  if (input.bingeEpisodes >= 4) traits.push('Binge-watcher');
  if (input.streak >= 7) traits.push('Creature of habit');
  if (input.movies > input.episodes && input.movies >= 3) traits.push('Film buff');
  else if (input.episodes > input.movies && input.episodes >= 5) traits.push('Series loyalist');
  if (input.musicShare >= 0.3) traits.push('Music lover');
  if (input.totalMinutes <= 0) return { id: 'newcomer', title: 'The Newcomer', description: 'Your story is just getting started. Press play and see who you become.', traits: [] };
  if (input.musicShare >= 0.6) return { id: 'soundtrack', title: 'The Soundtrack of Life', description: 'Most of your time went to music — there is always something playing when you are around.', traits };
  if (input.bingeEpisodes >= 6 && input.episodes > input.movies * 3) {
    return { id: 'binge-master', title: 'The Binge Master', description: `"Just one more episode" — you once watched ${input.bingeEpisodes} in a single day.`, traits };
  }
  const a = input.topGenre ? GENRE_ARCHETYPES.find((g) => g.match.test(input.topGenre!)) : undefined;
  if (a) return { id: a.id, title: a.title, description: a.description, traits };
  return { id: 'eclectic', title: 'The Eclectic', description: 'No single genre can hold you. Your watch history is a little bit of everything.', traits };
}

const daysInMonth = (year: number, m: number) => new Date(Date.UTC(year, m + 1, 0)).getUTCDate();

export function buildWrapped(userId: string, year: number | null, now = Date.now()): WrappedStory {
  const base = userStats(userId, year);
  const where = year ? 'WHERE h.user_id = ? AND h.started_at >= ? AND h.started_at < ?' : 'WHERE h.user_id = ?';
  const params = year ? [userId, `${year}-01-01`, `${year + 1}-01-01`] : [userId];
  const rows = db.all(`${SELECT} ${where} ORDER BY h.started_at`, ...params);

  const titles = new Map<string, StatsTopEntry>();
  const tracks = new Map<string, StatsTopEntry>();
  const titlePeople = new Map<string, Person[]>();
  const binges = new Map<string, { showId: string | null; title: string; posterUrl: string | null; episodes: Set<string>; minutes: number; date: string }>();
  const byDay = new Map<string, number>();
  let music = 0;
  for (const r of rows) {
    const min = minutesOf(r, now);
    if (min < 0.5) continue;
    const day = String(r.started_at).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + min);
    if (r.itype === 'movie' || r.itype === 'video') {
      bump(titles, r.item_id, { itemId: r.item_id, title: r.ititle, subtitle: 'Movie', posterUrl: imageUrl(r.iposter) }, min);
      if (!titlePeople.has(r.item_id)) titlePeople.set(r.item_id, parseJson<Person[]>(r.ipeople, []));
    } else if (r.itype === 'episode' && r.grandparent_id) {
      bump(titles, r.grandparent_id, { itemId: r.grandparent_id, title: r.gtitle ?? r.ititle, subtitle: 'Series', posterUrl: imageUrl(r.gposter) }, min);
      if (!titlePeople.has(r.grandparent_id)) titlePeople.set(r.grandparent_id, parseJson<Person[]>(r.gpeople, []));
      const k = `${day}|${r.grandparent_id}`;
      const b = binges.get(k) ?? { showId: r.grandparent_id, title: r.gtitle ?? r.ititle, posterUrl: imageUrl(r.gposter), episodes: new Set<string>(), minutes: 0, date: day };
      b.episodes.add(r.item_id);
      b.minutes += min;
      binges.set(k, b);
    } else if (r.itype === 'track') {
      music += min;
      bump(tracks, r.item_id, { itemId: r.item_id, title: r.ititle, subtitle: r.gtitle ?? null, posterUrl: imageUrl(r.pposter ?? r.iposter) }, min);
    }
  }

  // People: cast (top-billed) and directors of the titles, weighted by time spent on each title.
  const people = new Map<string, WrappedPerson>();
  for (const [id, list] of titlePeople) {
    const minutes = titles.get(id)?.minutes ?? 0;
    const seen = new Set<string>();
    list.filter((p) => p?.name && (p.kind === 'director' || p.kind === 'actor')).slice(0, 12).forEach((p, i) => {
      if (p.kind === 'actor' && i >= 8) return;
      if (seen.has(p.name)) return;
      seen.add(p.name);
      const e = people.get(p.name) ?? { name: p.name, kind: p.kind, imageUrl: p.imageUrl ?? null, minutes: 0, titles: 0 };
      e.minutes += minutes;
      e.titles++;
      if (!e.imageUrl && p.imageUrl) e.imageUrl = p.imageUrl;
      people.set(p.name, e);
    });
  }
  const topPeople = [...people.values()]
    .sort((a, b) => b.titles - a.titles || b.minutes - a.minutes || a.name.localeCompare(b.name))
    .slice(0, 6).map((p) => ({ ...p, minutes: Math.round(p.minutes) }));

  const bestBinge = [...binges.values()].sort((a, b) => b.episodes.size - a.episodes.size || b.minutes - a.minutes || a.date.localeCompare(b.date))[0];
  const binge = bestBinge && bestBinge.episodes.size >= 2
    ? { showId: bestBinge.showId, title: bestBinge.title, posterUrl: bestBinge.posterUrl, episodes: bestBinge.episodes.size, minutes: Math.round(bestBinge.minutes), date: bestBinge.date }
    : null;
  const bigDay = [...byDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  const heatmap = year ? Array.from({ length: 12 }, (_, m) => Array.from({ length: daysInMonth(year, m) }, (_, d) => {
    const key = `${year}-${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
    return Math.round(byDay.get(key) ?? 0);
  })) : [];

  const peak = Math.max(0, ...base.minutesByHour);
  const peakHour = peak > 0 ? base.minutesByHour.indexOf(peak) : null;
  let displayName = 'You';
  try {
    displayName = qualifiedName(getUser(userId));
  } catch {
    /* deleted user */
  }
  return {
    year, displayName, totalMinutes: base.totalMinutes, totalPlays: base.totalPlays, activeDays: byDay.size,
    moviesWatched: base.moviesWatched, episodesWatched: base.episodesWatched, tracksPlayed: base.tracksPlayed, longestStreakDays: base.longestStreakDays,
    topTitles: top(titles, 5), topGenres: base.topGenres.slice(0, 5), topPeople, binge,
    biggestDay: bigDay ? { date: bigDay[0], minutes: Math.round(bigDay[1]) } : null,
    personality: filmPersonality({
      topGenre: base.topGenres[0]?.genre ?? null, peakHour, bingeEpisodes: binge?.episodes ?? 0, movies: base.moviesWatched, episodes: base.episodesWatched,
      musicShare: base.totalMinutes > 0 ? music / base.totalMinutes : 0, streak: base.longestStreakDays, totalMinutes: base.totalMinutes,
    }),
    heatmap, minutesByMonth: base.minutesByMonth, topArtists: base.topArtists.slice(0, 5), topTracks: top(tracks, 5), musicMinutes: Math.round(music), peakHour,
  };
}
