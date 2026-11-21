import type { WrappedStory } from '@mediamax/shared';

/** One story card. The DOM view and the 1080×1920 PNG export both draw from this model. */
export interface StoryCard {
  id: string;
  kind: 'intro' | 'total' | 'titles' | 'genres' | 'people' | 'binge' | 'personality' | 'heatmap' | 'music' | 'outro';
  eyebrow: string;
  /** Big kinetic number / word (optional). */
  big?: string;
  bigUnit?: string;
  headline: string;
  sub?: string;
  /** Ranked rows (titles, genres, people, artists). */
  list?: { title: string; meta: string; image: string | null; round?: boolean }[];
  /** Hero artwork (also tints the background). */
  image?: string | null;
  /** Month × day minutes (heatmap card). */
  heat?: number[][];
  traits?: string[];
  /** Fallback accent hue (0-360) when there is no artwork to sample. */
  hue: number;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function hoursLabel(min: number): { value: string; unit: string } {
  if (min < 60) return { value: String(Math.round(min)), unit: Math.round(min) === 1 ? 'minute' : 'minutes' };
  const h = min / 60;
  const value = h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h).toLocaleString('en-US');
  return { value, unit: value === '1' ? 'hour' : 'hours' };
}
const fmtMin = (m: number) => {
  const h = hoursLabel(m);
  return `${h.value} ${h.unit === 'minutes' || h.unit === 'minute' ? 'min' : 'h'}`;
};
function prettyDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS_LONG[(m || 1) - 1]} ${d}${y ? `, ${y}` : ''}`;
}

/** The cards for a story, in order. Cards with nothing to show are left out. */
export function buildCards(s: WrappedStory, serverName: string): StoryCard[] {
  const period = s.year == null ? 'so far' : String(s.year);
  const cards: StoryCard[] = [];
  const first = s.topTitles[0];
  cards.push({
    id: 'intro', kind: 'intro', eyebrow: `${serverName} Wrapped`, big: s.year == null ? 'All time' : String(s.year),
    headline: s.year == null ? `${s.displayName}, here’s your story so far` : `${s.displayName}, this was your year`, sub: 'Tap to continue', image: first?.posterUrl ?? null, hue: 280,
  });
  if (s.totalMinutes <= 0) {
    cards.push({ id: 'outro', kind: 'outro', eyebrow: 'Nothing yet', headline: 'Your story starts with the first thing you press play on.', hue: 200 });
    return cards;
  }
  const t = hoursLabel(s.totalMinutes);
  cards.push({
    id: 'total', kind: 'total', eyebrow: `Your ${period} in time`, big: t.value, bigUnit: t.unit,
    headline: 'spent watching and listening', sub: `${s.totalPlays.toLocaleString('en-US')} plays across ${s.activeDays} day${s.activeDays === 1 ? '' : 's'}${s.longestStreakDays > 1 ? ` · ${s.longestStreakDays}-day streak` : ''}`,
    hue: 330,
  });
  if (s.topTitles.length) {
    cards.push({
      id: 'titles', kind: 'titles', eyebrow: 'On your screen', headline: first.title, sub: `was your number one (${fmtMin(first.minutes)})`, image: first.posterUrl,
      list: s.topTitles.slice(0, 5).map((e) => ({ title: e.title, meta: `${e.subtitle ?? ''}${e.subtitle ? ' · ' : ''}${fmtMin(e.minutes)}`, image: e.posterUrl })), hue: 20,
    });
  }
  if (s.topGenres.length) {
    cards.push({
      id: 'genres', kind: 'genres', eyebrow: 'Your genres', big: s.topGenres[0].genre, headline: 'came out on top', hue: 160,
      list: s.topGenres.slice(0, 5).map((g) => ({ title: g.genre, meta: fmtMin(g.minutes), image: null })),
    });
  }
  if (s.topPeople.length) {
    const p = s.topPeople[0];
    cards.push({
      id: 'people', kind: 'people', eyebrow: 'The faces of your year', headline: p.name, sub: `${p.kind === 'director' ? 'directed' : 'starred in'} ${p.titles} of the things you watched`, image: p.imageUrl,
      list: s.topPeople.slice(0, 5).map((x) => ({ title: x.name, meta: `${x.titles} title${x.titles === 1 ? '' : 's'}`, image: x.imageUrl, round: true })), hue: 45,
    });
  }
  if (s.binge) {
    cards.push({
      id: 'binge', kind: 'binge', eyebrow: 'Binge record', big: String(s.binge.episodes), bigUnit: 'episodes', headline: `of ${s.binge.title} in one day`,
      sub: `${prettyDate(s.binge.date)} · ${fmtMin(s.binge.minutes)} straight`, image: s.binge.posterUrl, hue: 0,
    });
  }
  cards.push({
    id: 'personality', kind: 'personality', eyebrow: 'Your film personality', headline: s.personality.title, sub: s.personality.description, traits: s.personality.traits, hue: 260,
  });
  if (s.heatmap.length === 12 && s.heatmap.some((m) => m.some((v) => v > 0))) {
    const peak = s.minutesByMonth.indexOf(Math.max(...s.minutesByMonth));
    cards.push({
      id: 'heatmap', kind: 'heatmap', eyebrow: 'Your year, day by day', headline: `${MONTHS_LONG[peak]} was your biggest month`,
      sub: s.biggestDay ? `Biggest day: ${prettyDate(s.biggestDay.date)} (${fmtMin(s.biggestDay.minutes)})` : undefined, heat: s.heatmap, hue: 190,
    });
  }
  if (s.topArtists.length || s.topTracks.length) {
    const a = s.topArtists[0];
    const tr = s.topTracks[0];
    cards.push({
      id: 'music', kind: 'music', eyebrow: 'On repeat', headline: a?.title ?? tr.title, sub: a ? `your top artist · ${fmtMin(s.musicMinutes)} of music` : `your top track · ${tr.plays} plays`,
      image: a?.posterUrl ?? tr?.posterUrl ?? null,
      list: s.topTracks.slice(0, 5).map((x) => ({ title: x.title, meta: `${x.subtitle ? `${x.subtitle} · ` : ''}${x.plays} play${x.plays === 1 ? '' : 's'}`, image: x.posterUrl })), hue: 300,
    });
  }
  cards.push({
    id: 'outro', kind: 'outro', eyebrow: `${serverName} Wrapped ${s.year ?? ''}`.trim(), big: t.value, bigUnit: t.unit,
    headline: s.personality.title, sub: [first && `#1 ${first.title}`, s.topGenres[0] && `Top genre ${s.topGenres[0].genre}`, s.topArtists[0] && `On repeat ${s.topArtists[0].title}`].filter(Boolean).join('  ·  '),
    image: first?.posterUrl ?? null, hue: 220,
  });
  return cards;
}

/** Background colours for a card from a sampled artwork colour (rgb) or the card's hue. */
export function tintColors(rgb: [number, number, number] | null, hue: number): { from: string; to: string; accent: string } {
  if (!rgb) return { from: `hsl(${hue} 70% 32%)`, to: `hsl(${(hue + 40) % 360} 75% 12%)`, accent: `hsl(${(hue + 180) % 360} 90% 70%)` };
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = Math.round(h * 60 + 360) % 360;
  } else h = hue;
  const sat = max === min ? 20 : Math.max(45, Math.min(85, Math.round(((max - min) / (1 - Math.abs(max + min - 1) || 1)) * 100)));
  return { from: `hsl(${h} ${sat}% 34%)`, to: `hsl(${(h + 30) % 360} ${sat}% 10%)`, accent: `hsl(${(h + 160) % 360} 90% 72%)` };
}
