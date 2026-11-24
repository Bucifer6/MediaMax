/**
 * Roulette — "Can't decide? Spin" (phone + TV). Movie or series, mood presets and quick filters; a poster reel
 * that accelerates and decelerates onto the pick (native-driver transform; reduced motion = fade), then a reveal
 * with Play, Spin again, Not this one and Marathon (random titles back to back).
 */
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Animated, Easing, ScrollView, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import type { RouletteFilters, RouletteMood, RouletteSpinResponse } from '@/api/types';
import { decide } from '@/api/decide';
import { useApi } from '@/state/session';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Img } from '@/components/Img';
import { Screen, ScreenHeader } from '@/components/Screen';
import { T } from '@/components/Text';
import { playItem } from '@/utils/nav';
import { useTheme } from '@/theme';
import { STILL } from '@/player/marathon';

const MOODS: { id: RouletteMood; label: string }[] = [
  { id: 'feel-good', label: 'Feel-good' }, { id: 'edge', label: 'Edge of your seat' }, { id: 'mind-bending', label: 'Mind-bending' },
  { id: 'laugh', label: 'Laugh' }, { id: 'family', label: 'Family night' }, { id: 'short', label: 'Short & sweet' },
];
const CARD_W = 110;
const GAP = 10;

export default function RouletteScreen() {
  const t = useTheme();
  const api = useApi();
  const d = decide(api);
  const { width } = useWindowDimensions();
  const [filters, setFilters] = useState<RouletteFilters>({ kind: 'movie', weighted: true });
  const [res, setRes] = useState<RouletteSpinResponse | null>(null);
  const [order, setOrder] = useState<{ id: string; path: string | null }[]>([]);
  const [spinning, setSpinning] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const x = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const reduce = useRef(false);
  const cardW = t.isTV ? t.s(160) : CARD_W;
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then((v) => (reduce.current = v)).catch(() => undefined);
  }, []);

  const set = (p: Partial<RouletteFilters>) => setFilters((f) => ({ ...f, ...p }));

  const spin = async (extra: string[] = []) => {
    if (spinning) return;
    setSpinning(true);
    setRevealed(false);
    fade.setValue(0);
    try {
      const r = await d.spin({ ...filters, excludeIds: [...excluded, ...extra] });
      setRes(r);
      if (!r.pick) return setSpinning(false);
      const decoys = r.decoys.length ? r.decoys : [{ id: r.pick.id, title: r.pick.title, posterUrl: r.pick.posterUrl }];
      const strip: { id: string; path: string | null }[] = [];
      const n = Math.max(24, decoys.length * 3);
      for (let i = 0; i < n; i++) strip.push({ id: decoys[i % decoys.length].id, path: decoys[i % decoys.length].posterUrl });
      const target = strip.length;
      strip.push({ id: r.pick.id, path: r.pick.posterUrl });
      for (let i = 0; i < 3; i++) strip.push({ id: decoys[i % decoys.length].id, path: decoys[i % decoys.length].posterUrl });
      setOrder(strip);
      const finalX = -(target * (cardW + GAP) + cardW / 2 - width / 2);
      x.setValue(0);
      const done = () => {
        setSpinning(false);
        setRevealed(true);
        Animated.timing(fade, { toValue: 1, duration: 250, useNativeDriver: true }).start();
      };
      if (reduce.current) {
        x.setValue(finalX);
        done();
      } else {
        Animated.timing(x, { toValue: finalX, duration: 4000, easing: Easing.bezier(0.35, 0, 0.08, 1), useNativeDriver: true }).start(done);
      }
    } catch (e) {
      setSpinning(false);
      Alert.alert('Roulette', (e as Error).message);
    }
  };

  const marathon = async (firstId?: string) => {
    try {
      const r = await d.startMarathon({ ...filters, randomEpisode: filters.kind === 'series' ? true : filters.randomEpisode, stillWatching: { ...STILL } });
      const id = firstId ?? r.item?.id;
      if (!id) return Alert.alert('Roulette', 'Nothing matches these filters');
      router.push(`/player/${id}?start=0&marathon=${encodeURIComponent(r.marathon.id)}` as never);
    } catch (e) {
      Alert.alert('Roulette', (e as Error).message);
    }
  };

  const pick = res?.pick ?? null;
  const target = pick ? (res?.episode ?? (pick.type === 'movie' ? pick : null)) : null;

  return (
    <Screen>
      <ScreenHeader title="Can't decide? Spin" />
      <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl, gap: t.space.md }}>
        <View style={{ flexDirection: 'row', gap: t.space.sm, paddingHorizontal: t.space.gutter }}>
          <Chip label="Movie" icon="film-outline" selected={filters.kind === 'movie'} onPress={() => set({ kind: 'movie' })} hasTVPreferredFocus />
          <Chip label="Series" icon="tv-outline" selected={filters.kind === 'series'} onPress={() => set({ kind: 'series' })} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space.sm, paddingHorizontal: t.space.gutter }}>
          {MOODS.map((m) => <Chip key={m.id} label={m.label} selected={filters.mood === m.id} onPress={() => set({ mood: filters.mood === m.id ? null : m.id })} />)}
        </ScrollView>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, paddingHorizontal: t.space.gutter }}>
          <Chip label="Unwatched only" icon="eye-off-outline" selected={!!filters.unwatchedOnly} onPress={() => set({ unwatchedOnly: !filters.unwatchedOnly })} />
          <Chip label="From My List" icon="bookmark-outline" selected={!!filters.fromMyList} onPress={() => set({ fromMyList: !filters.fromMyList })} />
          <Chip label="Favour top rated & new" icon="star-outline" selected={filters.weighted !== false} onPress={() => set({ weighted: filters.weighted === false })} />
          {filters.kind === 'series' && <Chip label="Random episode" icon="shuffle" selected={!!filters.randomEpisode} onPress={() => set({ randomEpisode: !filters.randomEpisode })} />}
        </View>

        <View style={{ height: cardW * 1.5 + 24, overflow: 'hidden', justifyContent: 'center' }}>
          {order.length ? (
            <Animated.View style={{ flexDirection: 'row', gap: GAP, transform: [{ translateX: x }] }}>
              {order.map((c, i) => (
                <View key={i} style={{ width: cardW, aspectRatio: 2 / 3, borderRadius: t.radius, overflow: 'hidden', backgroundColor: t.alpha(t.colors.text, 0.08) }}>
                  <Img path={c.path} width={cardW} style={{ width: '100%', height: '100%' }} />
                </View>
              ))}
            </Animated.View>
          ) : (
            <T tone="muted" center>Pick a mood, then spin.</T>
          )}
          <View pointerEvents="none" style={{ position: 'absolute', left: width / 2 - 1.5, top: 0, bottom: 0, width: 3, backgroundColor: t.colors.primary }} />
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: t.space.sm, flexWrap: 'wrap', paddingHorizontal: t.space.gutter }}>
          <Button label={res ? 'Spin again' : 'Spin'} icon="shuffle" size="lg" loading={spinning} onPress={() => spin()} />
          <Button label="Shuffle play" icon="play" size="lg" variant="secondary" onPress={() => marathon()} />
        </View>
        {res && !pick && !spinning && <T tone="muted" center>Nothing matches — try loosening the filters.</T>}

        {pick && revealed && (
          <Animated.View style={{ opacity: fade, marginHorizontal: t.space.gutter, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.text, 0.06), gap: t.space.sm }}>
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              <Img path={pick.posterUrl} width={100} style={{ width: 100, aspectRatio: 2 / 3, borderRadius: t.radius }} />
              <View style={{ flex: 1, gap: 4 }}>
                <T variant="caption" tone="primary">TONIGHT'S PICK</T>
                <T variant="title" numberOfLines={2}>{pick.title}</T>
                <T variant="small" tone="muted">{[pick.year, pick.contentRating, pick.communityRating ? `★ ${pick.communityRating.toFixed(1)}` : null].filter(Boolean).join(' · ')}</T>
                {res?.episode && <T variant="small" tone="primary">S{res.episode.parentIndex} · E{res.episode.index} — {res.episode.title}</T>}
              </View>
            </View>
            {pick.overview ? <T variant="small" numberOfLines={5}>{pick.overview}</T> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
              {target && <Button label="Play" icon="play" onPress={() => playItem(target.id, { restart: !target.userData.positionMs })} hasTVPreferredFocus />}
              <Button label="Not this one" icon="close" variant="secondary" onPress={() => { setExcluded((e) => [...e, pick.id]); void spin([pick.id]); }} />
              {target && <Button label="Marathon" icon="repeat" variant="ghost" onPress={() => marathon(target.id)} />}
              <Button label="Details" icon="information-circle-outline" variant="ghost" onPress={() => router.push(`/item/${pick.id}` as never)} />
            </View>
          </Animated.View>
        )}
      </ScrollView>
    </Screen>
  );
}
