/**
 * "Your Year" (Wrapped): a swipeable, story-style sequence of full-screen
 * cards built from GET /stats/me?year=. Phones swipe or tap the left/right
 * edge; on TV the remote's left/right moves between cards.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { StatsTopEntry, UserStats } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon, type IconName } from '@/components/Icon';
import { Img } from '@/components/Img';
import { OptionSheet } from '@/components/OptionSheet';
import { ErrorState, Loading } from '@/components/States';
import { T } from '@/components/Text';
import { useSession } from '@/state/session';
import { useTheme, type AppTheme } from '@/theme';
import { useTVRemote } from '@/tv';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const fmt = (n: number) => Math.round(n).toLocaleString();
const hours = (min: number) => (min >= 600 ? fmt(min / 60) : (Math.round((min / 60) * 10) / 10).toLocaleString());
const hourLabel = (h: number) => (h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`);
const argmax = (a: number[]) => a.reduce((best, v, i) => (v > a[best] ? i : best), 0);

type CardDef = { key: string; colors: [string, string, ...string[]]; render: () => React.ReactNode };

export default function WrappedScreen() {
  const now = new Date();
  // Early in the year the previous year is the interesting one.
  const [year, setYear] = useState<number | null>(now.getMonth() < 1 ? now.getFullYear() - 1 : now.getFullYear());
  const [picker, setPicker] = useState(false);
  const q = useQuery(`stats:me:${year ?? 'all'}`, (api) => api.myStats(year), { staleMs: 120000 });

  const years = useMemo(() => Array.from({ length: 7 }, (_, i) => now.getFullYear() - i), [now.getFullYear()]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {q.loading && !q.data ? <Loading label="Crunching your numbers…" /> : q.error && !q.data ? <ErrorState error={q.error} onRetry={q.refresh} /> : q.data ? <Stories key={year ?? 'all'} stats={q.data} year={year} onPickYear={() => setPicker(true)} /> : null}
      <OptionSheet
        visible={picker}
        title="Choose a year"
        options={[...years.map((y) => ({ key: String(y), label: String(y), selected: y === year })), { key: 'all', label: 'All time', selected: year == null }]}
        onSelect={(k) => {
          setPicker(false);
          setYear(k === 'all' ? null : Number(k));
        }}
        onClose={() => setPicker(false)}
      />
    </View>
  );
}

function Stories({ stats, year, onPickYear }: { stats: UserStats; year: number | null; onPickYear: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { user, branding } = useSession();
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [index, setIndex] = useState(0);
  const period = year == null ? 'all time' : String(year);
  const cards = useMemo(() => buildCards(t, stats, period, user?.displayName ?? '', branding?.serverName ?? 'Kinora'), [t, stats, period, user?.displayName, branding?.serverName]);
  const W = t.width;

  const go = (i: number) => {
    const next = Math.max(0, Math.min(cards.length - 1, i));
    setIndex(next);
    scroller.current?.scrollTo({ x: next * W, animated: true });
  };

  // Keep the current card in view across rotation / window resizes.
  useEffect(() => {
    scroller.current?.scrollTo({ x: index * W, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W]);

  useTVRemote((evt) => {
    const e = evt.eventType;
    if (e === 'right' || e === 'swipeRight' || e === 'fastForward') go(index + 1);
    else if (e === 'left' || e === 'swipeLeft' || e === 'rewind') go(index - 1);
  });

  const onMomentum = (e: NativeSyntheticEvent<NativeScrollEvent>) => setIndex(Math.round(e.nativeEvent.contentOffset.x / W));

  return (
    <View style={{ flex: 1 }}>
      <ScrollView ref={scroller} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onMomentumScrollEnd={onMomentum} scrollEnabled={!t.isTV} style={{ flex: 1 }}>
        {cards.map((c, i) => (
          <View key={c.key} style={{ width: W, height: '100%' }}>
            <LinearGradient colors={c.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
            <Decor seed={i} />
            <View style={{ flex: 1, paddingTop: (t.isTV ? t.s(70) : insets.top + 70), paddingBottom: t.isTV ? t.s(60) : insets.bottom + 40, paddingHorizontal: t.isTV ? t.s(120) : 28, justifyContent: 'center' }}>
              <View style={{ width: '100%', maxWidth: t.isTV ? t.s(980) : 560, alignSelf: 'center' }}>{c.render()}</View>
            </View>
            {/* Tap the left / right edge to step through, like stories. */}
            {!t.isTV ? (
              <>
                <Pressable accessibilityLabel="Previous card" onPress={() => go(i - 1)} style={{ position: 'absolute', left: 0, top: insets.top + 60, bottom: 0, width: '22%' }} />
                <Pressable accessibilityLabel="Next card" onPress={() => go(i + 1)} style={{ position: 'absolute', right: 0, top: insets.top + 60, bottom: 0, width: '22%' }} />
              </>
            ) : null}
          </View>
        ))}
      </ScrollView>

      {/* Story progress + header */}
      <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: t.isTV ? t.s(24) : insets.top + 8, paddingHorizontal: t.isTV ? t.s(60) : 12, gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 4 }} pointerEvents="none">
          {cards.map((c, i) => (
            <View key={c.key} style={{ flex: 1, height: t.isTV ? t.s(4) : 3, borderRadius: 2, backgroundColor: i <= index ? '#fff' : 'rgba(255,255,255,0.3)' }} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }} pointerEvents="box-none">
          {!t.isTV ? (
            <Focusable onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/settings'))} accessibilityLabel="Close" style={{ padding: 6 }}>
              <Icon name="close" color="#fff" size={26} />
            </Focusable>
          ) : null}
          <View style={{ flex: 1 }} />
          <Focusable onPress={onPickYear} hasTVPreferredFocus ringRadius={999} accessibilityLabel="Choose year" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: t.isTV ? t.s(16) : 12, paddingVertical: t.isTV ? t.s(8) : 6, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.3)' }}>
            <Icon name="calendar-outline" color="#fff" size={t.isTV ? t.s(20) : 16} />
            <T weight="800" color="#fff">
              {year ?? 'All time'}
            </T>
            <Icon name="chevron-down" color="#fff" size={t.isTV ? t.s(18) : 14} />
          </Focusable>
        </View>
      </View>
      {t.isTV ? (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: t.s(24), left: 0, right: 0, alignItems: 'center' }}>
          <T variant="small" color="rgba(255,255,255,0.7)">
            ◀ ▶ to move between cards · {index + 1}/{cards.length}
          </T>
        </View>
      ) : null}
      {index === cards.length - 1 && !t.isTV ? (
        <View style={{ position: 'absolute', bottom: insets.bottom + 16, left: 0, right: 0, alignItems: 'center' }}>
          <Button label="Watch again" icon="refresh" variant="secondary" onPress={() => go(0)} />
        </View>
      ) : null}
    </View>
  );
}

/** Soft translucent circles so the gradient cards feel less flat. */
function Decor({ seed }: { seed: number }) {
  const t = useTheme();
  const big = Math.max(t.width, t.height);
  const spots = [
    { x: 0.8, y: 0.15, r: 0.35 },
    { x: 0.1, y: 0.85, r: 0.45 },
    { x: 0.95, y: 0.9, r: 0.2 },
  ];
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
      {spots.map((s, i) => {
        const r = big * s.r * (1 + ((seed + i) % 3) * 0.15);
        return <View key={i} style={{ position: 'absolute', left: t.width * ((s.x + seed * 0.13) % 1) - r / 2, top: t.height * ((s.y + seed * 0.07) % 1) - r / 2, width: r, height: r, borderRadius: r / 2, backgroundColor: 'rgba(255,255,255,0.07)' }} />;
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Card building blocks                                                */
/* ------------------------------------------------------------------ */

function Kicker({ children, icon }: { children: React.ReactNode; icon?: IconName }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: t.space.md }}>
      {icon ? <Icon name={icon} color="rgba(255,255,255,0.9)" size={t.isTV ? t.s(24) : 20} /> : null}
      <T variant="caption" color="rgba(255,255,255,0.85)" style={{ textTransform: 'uppercase', letterSpacing: 2 }}>
        {children}
      </T>
    </View>
  );
}

function Huge({ children, sub }: { children: React.ReactNode; sub?: string }) {
  const t = useTheme();
  const size = t.isTV ? t.s(130) : t.wide ? 110 : 84;
  return (
    <View>
      <T weight="900" color="#fff" style={{ fontSize: size, lineHeight: size * 1.05, letterSpacing: -2 }} adjustsFontSizeToFit numberOfLines={1}>
        {children}
      </T>
      {sub ? (
        <T variant="heading" color="rgba(255,255,255,0.9)">
          {sub}
        </T>
      ) : null}
    </View>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <T color="rgba(255,255,255,0.88)" style={{ fontSize: t.isTV ? t.s(24) : 18, lineHeight: t.isTV ? t.s(34) : 26, marginTop: t.space.md }}>
      {children}
    </T>
  );
}

function TopEntryCard({ entry, others, unit }: { entry: StatsTopEntry; others: StatsTopEntry[]; unit: 'plays' | 'minutes' }) {
  const t = useTheme();
  const pw = t.isTV ? t.s(220) : t.wide ? 180 : 140;
  return (
    <View style={{ gap: t.space.lg }}>
      <View style={{ flexDirection: 'row', gap: t.space.lg, alignItems: 'flex-end' }}>
        <View style={{ width: pw, height: pw * 1.5, borderRadius: t.radius, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.25)', shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 20, elevation: 10, alignItems: 'center', justifyContent: 'center' }}>
          {entry.posterUrl ? <Img path={entry.posterUrl} width={pw} style={{ width: '100%', height: '100%' }} /> : <Icon name="film-outline" size={pw / 3} color="rgba(255,255,255,0.6)" />}
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <T weight="900" color="#fff" style={{ fontSize: t.isTV ? t.s(44) : 30, lineHeight: t.isTV ? t.s(50) : 35 }} numberOfLines={3}>
            {entry.title}
          </T>
          {entry.subtitle ? (
            <T color="rgba(255,255,255,0.8)" numberOfLines={1}>
              {entry.subtitle}
            </T>
          ) : null}
          <T variant="heading" color="#fff" style={{ marginTop: 6 }}>
            {unit === 'plays' ? `${fmt(entry.plays)} plays` : `${hours(entry.minutes)} hours`}
          </T>
        </View>
      </View>
      {others.length ? (
        <View style={{ gap: 6 }}>
          {others.map((o, i) => (
            <View key={`${o.itemId}-${i}`} style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'center' }}>
              <T weight="900" color="rgba(255,255,255,0.6)" style={{ width: t.isTV ? t.s(30) : 22 }}>
                {i + 2}
              </T>
              <T weight="700" color="#fff" style={{ flex: 1 }} numberOfLines={1}>
                {o.title}
              </T>
              <T variant="small" color="rgba(255,255,255,0.75)">
                {unit === 'plays' ? `${fmt(o.plays)} plays` : `${hours(o.minutes)} h`}
              </T>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Bars({ values, labels, highlight }: { values: number[]; labels: string[]; highlight?: number }) {
  const t = useTheme();
  const max = Math.max(1, ...values);
  const h = t.isTV ? t.s(120) : 90;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: t.isTV ? t.s(8) : 5, height: h + 22, marginTop: t.space.lg }} accessibilityLabel="Minutes per month">
      {values.map((v, i) => (
        <View key={i} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
          <View style={{ width: '100%', height: Math.max(3, (v / max) * h), borderRadius: 4, backgroundColor: i === highlight ? '#fff' : 'rgba(255,255,255,0.45)' }} />
          <T variant="caption" color="rgba(255,255,255,0.75)" style={{ letterSpacing: 0 }}>
            {labels[i]}
          </T>
        </View>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* The deck                                                            */
/* ------------------------------------------------------------------ */

function buildCards(t: AppTheme, s: UserStats, period: string, name: string, serverName: string): CardDef[] {
  const c = t.colors;
  // Theme-driven palettes, darkened enough for white text.
  const pal = (a: string, b: string): [string, string, string] => [a, b, '#0b0b12'];
  const palettes: [string, string, string][] = [pal(c.primary, c.accent), pal(c.accent, c.primary), pal('#7b2ff7', c.primary), pal(c.primary, '#0f9b8e'), pal('#f7971e', c.accent), pal(c.accent, '#1d2b64'), pal('#e94057', c.primary), pal(c.primary, '#2c3e50')];
  const cards: CardDef[] = [];
  const add = (key: string, render: () => React.ReactNode) => cards.push({ key, colors: palettes[cards.length % palettes.length], render });
  const empty = s.totalPlays === 0;

  add('intro', () => (
    <View>
      <Kicker icon="sparkles">{serverName} Wrapped</Kicker>
      <T weight="900" color="#fff" style={{ fontSize: t.isTV ? t.s(80) : 52, lineHeight: t.isTV ? t.s(88) : 58 }}>
        {period === 'all time' ? 'Your story so far' : `Your ${period}`}
      </T>
      <Line>{empty ? `Nothing played ${period === 'all time' ? 'yet' : `in ${period}`}, ${name}. Press play on something and come back!` : `${name}, here's what you watched and listened to. ${t.isTV ? 'Press ▶ to begin.' : 'Swipe to begin.'}`}</Line>
    </View>
  ));
  if (empty) return cards;

  const watchedLine = [s.moviesWatched ? `${fmt(s.moviesWatched)} movies` : null, s.episodesWatched ? `${fmt(s.episodesWatched)} episodes` : null, s.tracksPlayed ? `${fmt(s.tracksPlayed)} songs` : null].filter(Boolean).join(', ');
  const peakMonth = s.minutesByMonth?.length === 12 ? argmax(s.minutesByMonth) : -1;
  add('hours', () => (
    <View>
      <Kicker icon="time-outline">Time well spent</Kicker>
      <Huge sub="hours of watching & listening">{hours(s.totalMinutes)}</Huge>
      <Line>
        That's {fmt(s.totalPlays)} plays{watchedLine ? ` — ${watchedLine}` : ''}.{s.liveTvMinutes > 0 ? ` Plus ${hours(s.liveTvMinutes)} hours of live TV.` : ''}
      </Line>
      {peakMonth >= 0 && s.minutesByMonth[peakMonth] > 0 ? <Bars values={s.minutesByMonth} labels={MONTHS} highlight={peakMonth} /> : null}
    </View>
  ));

  const show = s.topShows[0];
  if (show)
    add('show', () => (
      <View>
        <Kicker icon="tv-outline">Your top show</Kicker>
        <TopEntryCard entry={show} others={s.topShows.slice(1, 5)} unit="minutes" />
      </View>
    ));

  const movie = s.topMovies[0];
  if (movie)
    add('movie', () => (
      <View>
        <Kicker icon="film-outline">Your top movie</Kicker>
        <TopEntryCard entry={movie} others={s.topMovies.slice(1, 5)} unit="plays" />
      </View>
    ));

  if (s.topGenres.length) {
    const g = s.topGenres.slice(0, 5);
    const max = Math.max(1, g[0].minutes);
    add('genres', () => (
      <View>
        <Kicker icon="pricetags-outline">Your top genres</Kicker>
        <T weight="900" color="#fff" style={{ fontSize: t.isTV ? t.s(64) : 44, lineHeight: t.isTV ? t.s(72) : 50 }} numberOfLines={2}>
          {g[0].genre}
        </T>
        <View style={{ gap: t.space.sm, marginTop: t.space.lg }}>
          {g.map((x, i) => (
            <View key={x.genre} style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <T weight="800" color="#fff">
                  {i + 1}. {x.genre}
                </T>
                <T variant="small" color="rgba(255,255,255,0.8)">
                  {hours(x.minutes)} h
                </T>
              </View>
              <View style={{ height: t.isTV ? t.s(10) : 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}>
                <View style={{ width: `${(x.minutes / max) * 100}%`, height: '100%', borderRadius: 999, backgroundColor: i === 0 ? '#fff' : 'rgba(255,255,255,0.6)' }} />
              </View>
            </View>
          ))}
        </View>
      </View>
    ));
  }

  const day = s.minutesByWeekday?.length === 7 && Math.max(...s.minutesByWeekday) > 0 ? WEEKDAYS[argmax(s.minutesByWeekday)] : null;
  const hour = s.minutesByHour?.length === 24 && Math.max(...s.minutesByHour) > 0 ? argmax(s.minutesByHour) : null;
  if (s.longestStreakDays > 0 || day)
    add('streak', () => (
      <View>
        <Kicker icon="flame-outline">On a roll</Kicker>
        <Huge sub={s.longestStreakDays === 1 ? 'day in a row' : 'days in a row'}>{fmt(s.longestStreakDays)}</Huge>
        <Line>
          Your longest streak{day ? `. ${day}s were your favourite day` : ''}
          {hour != null ? `, and you were most likely to press play around ${hourLabel(hour)}` : ''}.
        </Line>
      </View>
    ));

  const artist = s.topArtists[0];
  if (artist)
    add('artist', () => (
      <View>
        <Kicker icon="musical-notes-outline">Your top artist</Kicker>
        <TopEntryCard entry={artist} others={s.topArtists.slice(1, 5)} unit="plays" />
      </View>
    ));

  if (s.highlights.length)
    add('highlights', () => (
      <View>
        <Kicker icon="star-outline">Highlights</Kicker>
        <View style={{ gap: t.space.md }}>
          {s.highlights.slice(0, 6).map((h, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'flex-start' }}>
              <Icon name="sparkles" color="#fff" size={t.isTV ? t.s(26) : 20} style={{ marginTop: 3 }} />
              <T weight="700" color="#fff" style={{ flex: 1, fontSize: t.isTV ? t.s(28) : 20, lineHeight: t.isTV ? t.s(38) : 28 }}>
                {h}
              </T>
            </View>
          ))}
        </View>
      </View>
    ));

  add('summary', () => {
    const tiles: { label: string; value: string }[] = [
      { label: 'Hours', value: hours(s.totalMinutes) },
      { label: 'Plays', value: fmt(s.totalPlays) },
      { label: 'Movies', value: fmt(s.moviesWatched) },
      { label: 'Episodes', value: fmt(s.episodesWatched) },
      { label: 'Songs', value: fmt(s.tracksPlayed) },
      { label: 'Best streak', value: `${fmt(s.longestStreakDays)}d` },
    ];
    const tops = [
      show ? { k: 'Top show', v: show.title } : null,
      movie ? { k: 'Top movie', v: movie.title } : null,
      artist ? { k: 'Top artist', v: artist.title } : null,
      s.topGenres[0] ? { k: 'Top genre', v: s.topGenres[0].genre } : null,
    ].filter(Boolean) as { k: string; v: string }[];
    return (
      <View style={{ padding: t.isTV ? t.s(36) : 22, borderRadius: t.radius * 1.5, backgroundColor: 'rgba(0,0,0,0.3)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' }}>
        <Kicker icon="ribbon-outline">{period === 'all time' ? 'All time' : period} · {name}</Kicker>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: t.space.md }}>
          {tiles.map((x) => (
            <View key={x.label} style={{ width: t.isTV || t.wide ? '33.33%' : '50%' }}>
              <T weight="900" color="#fff" style={{ fontSize: t.isTV ? t.s(44) : 30, lineHeight: t.isTV ? t.s(50) : 36 }}>
                {x.value}
              </T>
              <T variant="caption" color="rgba(255,255,255,0.75)" style={{ textTransform: 'uppercase' }}>
                {x.label}
              </T>
            </View>
          ))}
        </View>
        {tops.length ? (
          <View style={{ gap: 6, marginTop: t.space.lg, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)', paddingTop: t.space.md }}>
            {tops.map((x) => (
              <View key={x.k} style={{ flexDirection: 'row', gap: t.space.md }}>
                <T variant="small" color="rgba(255,255,255,0.7)" style={{ width: t.isTV ? t.s(140) : 96 }}>
                  {x.k}
                </T>
                <T weight="800" color="#fff" style={{ flex: 1 }} numberOfLines={1}>
                  {x.v}
                </T>
              </View>
            ))}
          </View>
        ) : null}
        <T variant="small" color="rgba(255,255,255,0.6)" style={{ marginTop: t.space.md }}>
          {serverName}
        </T>
      </View>
    );
  });

  return cards;
}
