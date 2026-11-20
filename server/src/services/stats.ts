import type { ServerStats, StatsTopEntry, UserStats } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { imageUrl } from './images.js';
import { parseJson } from '../util/misc.js';

/** Minutes for a history row: wall-clock session time, capped by the item's runtime (pauses shouldn't count). */
function minutesOf(r: Row): number {
  let ms = r.duration_ms ?? 0;
  if (!ms && !r.ended_at) ms = Math.max(0, Date.now() - Date.parse(r.started_at));
  if (r.item_duration) ms = Math.min(ms, r.item_duration * 1.1);
  return Math.max(0, ms / 60000);
}

const HISTORY_SELECT = `SELECT h.*, i.type itype, i.title ititle, i.genres igenres, i.duration_ms item_duration, i.poster iposter,
    i.grandparent_id, g.title gtitle, g.poster gposter, g.genres ggenres, p.title ptitle, p.poster pposter,
    c.name cname, c.logo clogo
  FROM play_history h
  LEFT JOIN items i ON i.id = h.item_id
  LEFT JOIN items p ON p.id = i.parent_id
  LEFT JOIN items g ON g.id = i.grandparent_id
  LEFT JOIN channels c ON c.id = h.channel_id`;

function top(map: Map<string, StatsTopEntry>, n = 10): StatsTopEntry[] {
  return [...map.values()].sort((a, b) => b.minutes - a.minutes || b.plays - a.plays).slice(0, n).map((e) => ({ ...e, minutes: Math.round(e.minutes) }));
}

function bump(map: Map<string, StatsTopEntry>, key: string, base: Omit<StatsTopEntry, 'plays' | 'minutes'>, minutes: number) {
  const e = map.get(key) ?? { ...base, plays: 0, minutes: 0 };
  e.plays++;
  e.minutes += minutes;
  map.set(key, e);
}

export function userStats(userId: string, year: number | null): UserStats {
  const where = year ? `WHERE h.user_id = ? AND h.started_at >= ? AND h.started_at < ?` : 'WHERE h.user_id = ?';
  const params = year ? [userId, `${year}-01-01`, `${year + 1}-01-01`] : [userId];
  const rows = db.all(`${HISTORY_SELECT} ${where} ORDER BY h.started_at`, ...params);
  const byMonth = Array(12).fill(0);
  const byWeekday = Array(7).fill(0);
  const byHour = Array(24).fill(0);
  const genres = new Map<string, number>();
  const movies = new Map<string, StatsTopEntry>();
  const shows = new Map<string, StatsTopEntry>();
  const artists = new Map<string, StatsTopEntry>();
  const channels = new Map<string, StatsTopEntry>();
  const days = new Set<string>();
  let total = 0;
  let live = 0;
  const watchedMovies = new Set<string>();
  const watchedEpisodes = new Set<string>();
  let tracks = 0;
  for (const r of rows) {
    const min = minutesOf(r);
    if (min < 0.5) continue;
    const d = new Date(r.started_at);
    total += min;
    byMonth[d.getMonth()] += min;
    byWeekday[d.getDay()] += min;
    byHour[d.getHours()] += min;
    days.add(r.started_at.slice(0, 10));
    for (const g of parseJson<string[]>(r.igenres ?? r.ggenres, []).slice(0, 3)) genres.set(g, (genres.get(g) ?? 0) + min);
    if (r.channel_id) {
      live += min;
      bump(channels, r.channel_id, { itemId: null, title: r.cname ?? 'Live TV', subtitle: null, posterUrl: imageUrl(r.clogo) }, min);
    } else if (r.itype === 'movie' || r.itype === 'video') {
      watchedMovies.add(r.item_id);
      bump(movies, r.item_id, { itemId: r.item_id, title: r.ititle, subtitle: null, posterUrl: imageUrl(r.iposter) }, min);
    } else if (r.itype === 'episode' && r.grandparent_id) {
      watchedEpisodes.add(r.item_id);
      bump(shows, r.grandparent_id, { itemId: r.grandparent_id, title: r.gtitle ?? r.ititle, subtitle: null, posterUrl: imageUrl(r.gposter) }, min);
    } else if (r.itype === 'track') {
      tracks++;
      if (r.grandparent_id) bump(artists, r.grandparent_id, { itemId: r.grandparent_id, title: r.gtitle ?? 'Unknown artist', subtitle: null, posterUrl: imageUrl(r.gposter ?? r.pposter) }, min);
    }
  }
  // Longest streak of consecutive days.
  const sorted = [...days].sort();
  let streak = 0;
  let best = 0;
  let prev: number | null = null;
  for (const day of sorted) {
    const t = Date.parse(day);
    streak = prev !== null && t - prev === 86400000 ? streak + 1 : 1;
    best = Math.max(best, streak);
    prev = t;
  }
  const topGenres = [...genres.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([genre, m]) => ({ genre, minutes: Math.round(m) }));
  const topShows = top(shows);
  const topMovies = top(movies);
  const topArtists = top(artists);
  const highlights: string[] = [];
  const hours = Math.round(total / 60);
  if (hours) highlights.push(`You spent ${hours.toLocaleString()} hour${hours === 1 ? '' : 's'} watching and listening${year ? ` in ${year}` : ''}.`);
  if (topShows[0]) highlights.push(`Your most-watched show was ${topShows[0].title} (${Math.round(topShows[0].minutes / 60)}h).`);
  if (topMovies[0]) highlights.push(`Your top movie was ${topMovies[0].title}.`);
  if (topGenres[0]) highlights.push(`${topGenres[0].genre} was your genre of choice.`);
  if (best > 1) highlights.push(`Your longest streak was ${best} days in a row.`);
  const peakHour = byHour.indexOf(Math.max(...byHour));
  if (total > 0) highlights.push(peakHour >= 22 || peakHour < 5 ? 'You are a certified night owl 🦉' : peakHour < 12 ? 'You like to start the day with something good ☀️' : 'Prime time is your time 📺');
  if (topArtists[0]) highlights.push(`On repeat: ${topArtists[0].title}.`);
  return {
    year, totalMinutes: Math.round(total), totalPlays: rows.length, moviesWatched: watchedMovies.size, episodesWatched: watchedEpisodes.size,
    tracksPlayed: tracks, liveTvMinutes: Math.round(live), longestStreakDays: best,
    minutesByMonth: year ? byMonth.map(Math.round) : [], minutesByWeekday: byWeekday.map(Math.round), minutesByHour: byHour.map(Math.round),
    topGenres, topMovies, topShows, topArtists, topChannels: top(channels), highlights,
  };
}

export function serverStats(days: number): ServerStats {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.all(`${HISTORY_SELECT.replace('SELECT h.*', 'SELECT h.*, u.display_name uname')} LEFT JOIN users u ON u.id = h.user_id WHERE h.started_at >= ? ORDER BY h.started_at`, since);
  const byUser = new Map<string, { userId: string; userName: string; plays: number; minutes: number }>();
  const byPlatform = new Map<string, number>();
  const byMethod = new Map<string, number>();
  const items = new Map<string, StatsTopEntry>();
  const byDay = new Map<string, { plays: number; minutes: number }>();
  let total = 0;
  for (const r of rows) {
    const min = minutesOf(r);
    total += min;
    const u = byUser.get(r.user_id) ?? { userId: r.user_id, userName: r.uname ?? 'Deleted user', plays: 0, minutes: 0 };
    u.plays++;
    u.minutes += min;
    byUser.set(r.user_id, u);
    byPlatform.set(r.platform ?? 'other', (byPlatform.get(r.platform ?? 'other') ?? 0) + 1);
    byMethod.set(r.method ?? 'direct', (byMethod.get(r.method ?? 'direct') ?? 0) + 1);
    const day = r.started_at.slice(0, 10);
    const d = byDay.get(day) ?? { plays: 0, minutes: 0 };
    d.plays++;
    d.minutes += min;
    byDay.set(day, d);
    if (r.itype === 'episode' && r.grandparent_id) bump(items, r.grandparent_id, { itemId: r.grandparent_id, title: r.gtitle, subtitle: null, posterUrl: imageUrl(r.gposter) }, min);
    else if (r.item_id && r.ititle) bump(items, r.item_id, { itemId: r.item_id, title: r.ititle, subtitle: r.itype === 'track' ? r.gtitle : null, posterUrl: imageUrl(r.iposter ?? r.pposter) }, min);
    else if (r.channel_id) bump(items, `ch:${r.channel_id}`, { itemId: null, title: r.cname ?? 'Live TV', subtitle: 'Live TV', posterUrl: imageUrl(r.clogo) }, min);
  }
  const playsByDay: ServerStats['playsByDay'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const d = byDay.get(date);
    playsByDay.push({ date, plays: d?.plays ?? 0, minutes: Math.round(d?.minutes ?? 0) });
  }
  return {
    days, totalPlays: rows.length, totalMinutes: Math.round(total),
    byUser: [...byUser.values()].map((u) => ({ ...u, minutes: Math.round(u.minutes) })).sort((a, b) => b.minutes - a.minutes),
    byPlatform: [...byPlatform.entries()].map(([platform, plays]) => ({ platform, plays })).sort((a, b) => b.plays - a.plays),
    byMethod: [...byMethod.entries()].map(([method, plays]) => ({ method, plays })).sort((a, b) => b.plays - a.plays),
    topItems: top(items, 15), playsByDay,
  };
}
