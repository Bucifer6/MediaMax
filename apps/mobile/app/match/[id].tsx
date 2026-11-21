/**
 * Movie Match session on the phone (and Android TV / Apple TV): swipe the shared deck (drag with spring-back,
 * or the buttons / D-pad), see who's still swiping, and get "It's a match!" with confetti on every device at once,
 * with "Play on…" the device that hosts the session.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, Modal, PanResponder, ScrollView, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { Item, MatchResult, MatchSessionState, MatchVote } from '@/api/types';
import { decide, swipeVote } from '@/api/decide';
import { useApi, useSession } from '@/state/session';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState, Loading } from '@/components/States';
import { T } from '@/components/Text';
import { playItem } from '@/utils/nav';
import { useTheme } from '@/theme';

/** Fills the card slot (StyleSheet.absoluteFillObject is gone from current React Native). */
const FILL = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

export default function MatchSessionScreen() {
  const t = useTheme();
  const api = useApi();
  const d = useMemo(() => decide(api), [api]);
  const { socket, user } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [state, setState] = useState<MatchSessionState | null>(null);
  const [cards, setCards] = useState<Item[]>([]);
  const [offset, setOffset] = useState(0);
  const [found, setFound] = useState<MatchResult | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [tab, setTab] = useState<'swipe' | 'matches'>('swipe');
  const loading = useRef(false);

  const load = useCallback(async (from: number, replace = false) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const r = await d.deck(id, from, 20);
      const fresh = r.cards.filter((c) => !r.myVotes[c.id]);
      setCards((c) => (replace ? fresh : [...c, ...fresh.filter((x) => !c.some((y) => y.id === x.id))]));
      setOffset(r.offset + r.cards.length);
    } catch (e) {
      setEnded((e as Error).message);
    } finally {
      loading.current = false;
    }
  }, [d, id]);

  const refresh = useCallback(() => d.match(id).then((s) => { setState(s); return s; }).catch((e) => { setEnded((e as Error).message); return null; }), [d, id]);

  useEffect(() => {
    void refresh().then((s) => s && load(s.myCursor, true));
    const iv = setInterval(() => void refresh(), 20000);
    return () => clearInterval(iv);
  }, [refresh, load]);

  useEffect(() => {
    if (!socket) return;
    const off = socket.subscribe((ev) => {
      if (ev.type === 'match.state' && ev.session.id === id) setState(ev.session);
      else if (ev.type === 'match.found' && ev.sessionId === id) setFound(ev.match);
      else if (ev.type === 'match.ended' && ev.sessionId === id) setEnded(ev.reason === 'host' ? 'The host ended the session.' : 'The session timed out.');
    });
    const offOpen = socket.onOpen(() => void refresh());
    return () => {
      off();
      offOpen();
    };
  }, [socket, id, refresh]);

  useEffect(() => {
    if (state && cards.length < 4 && offset < state.deckSize) void load(Math.max(offset, state.myCursor));
  }, [state, cards.length, offset, load]);

  const vote = useCallback(async (item: Item, v: MatchVote) => {
    setCards((c) => c.filter((x) => x.id !== item.id));
    try {
      const r = await d.vote(id, item.id, v);
      setState(r.state);
      if (r.match) setFound(r.match);
    } catch (e) {
      Alert.alert('Movie Match', (e as Error).message);
    }
  }, [d, id]);

  const isHost = state?.hostUserId === user?.id;
  const leave = () => {
    Alert.alert(isHost ? 'End this session?' : 'Leave this session?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: isHost ? 'End' : 'Leave', style: 'destructive', onPress: () => { void (isHost ? d.end(id) : d.leave(id)).catch(() => undefined); router.back(); } },
    ]);
  };
  const playOnHost = async (m: MatchResult) => {
    try {
      const r = await d.playOnHost(id, m.itemId);
      setFound(null);
      Alert.alert('Movie Match', `Starting on ${r.deviceName}`);
    } catch (e) {
      Alert.alert('Movie Match', (e as Error).message);
    }
  };

  if (ended) return <Screen><ScreenHeader title="Movie Match" /><EmptyState icon="people-outline" title="Session over" message={ended} action="New session" onAction={() => router.replace('/match' as never)} /></Screen>;
  if (!state) return <Screen><ScreenHeader title="Movie Match" /><Loading /></Screen>;

  const hostName = state.hostDeviceOnline ? state.hostDeviceName : null;
  return (
    <Screen>
      <ScreenHeader title={`Code ${state.code}`} subtitle={`${state.members.filter((m) => m.done).length}/${state.members.length} done · ${state.settings.rule === 'all' ? 'everyone must say yes' : 'majority wins'}`}
        right={<Button icon={isHost ? 'close' : 'exit-outline'} variant="ghost" size="sm" onPress={leave} accessibilityLabel={isHost ? 'End session' : 'Leave'} />} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space.sm, paddingHorizontal: t.space.gutter, paddingBottom: t.space.sm }}>
        {state.members.map((m) => (
          <View key={m.userId} style={{ alignItems: 'center', opacity: m.online ? 1 : 0.5, width: 64 }}>
            <View style={{ width: 40, height: 40, borderRadius: 20, overflow: 'hidden', borderWidth: 2, borderColor: m.done ? t.colors.success : m.online ? t.colors.primary : 'transparent', backgroundColor: t.alpha(t.colors.text, 0.1), alignItems: 'center', justifyContent: 'center' }}>
              {m.avatarUrl ? <Img path={m.avatarUrl} width={40} style={{ width: 40, height: 40 }} /> : <T weight="700">{m.displayName.slice(0, 1).toUpperCase()}</T>}
            </View>
            <T variant="caption" numberOfLines={1}>{m.displayName}</T>
            <T variant="caption" tone={m.done ? 'success' : 'muted'}>{!m.online ? 'away' : m.done ? 'done' : 'swiping…'}</T>
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: t.space.sm, paddingHorizontal: t.space.gutter }}>
        <Chip label="Swipe" selected={tab === 'swipe'} onPress={() => setTab('swipe')} />
        <Chip label={`Matches${state.matches.length ? ` · ${state.matches.length}` : ''}`} selected={tab === 'matches'} onPress={() => setTab('matches')} />
      </View>
      {tab === 'swipe' ? (
        cards[0] ? <Deck cards={cards} onVote={vote} /> : (
          <EmptyState icon="checkmark-circle-outline" title={state.myCursor >= state.deckSize ? "You're through the deck" : 'Loading cards…'}
            action={state.myCursor >= state.deckSize ? 'More cards' : undefined} onAction={() => d.extend(id).then(setState).catch(() => undefined)} />
        )
      ) : (
        <ScrollView contentContainerStyle={{ padding: t.space.gutter, gap: t.space.sm }}>
          {state.matches.length === 0 && <T tone="muted">No matches yet — keep swiping.</T>}
          {state.matches.map((m, i) => (
            <View key={m.itemId} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, padding: t.space.sm, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.text, 0.06) }}>
              <T variant="heading" tone="primary">{i + 1}</T>
              <Img path={m.posterUrl} width={48} style={{ width: 48, aspectRatio: 2 / 3, borderRadius: 6 }} />
              <View style={{ flex: 1 }}>
                <T weight="700" numberOfLines={1}>{m.title}</T>
                <T variant="small" tone="muted">{m.superLikes ? `${m.superLikes}★ · ` : ''}{m.yes} yes{m.no ? ` · ${m.no} no` : ''}</T>
              </View>
              {hostName && <Button icon="tv-outline" size="sm" onPress={() => playOnHost(m)} accessibilityLabel={`Play on ${hostName}`} />}
              <Button icon="play" size="sm" variant="secondary" onPress={() => playItem(m.itemId, { restart: true })} accessibilityLabel="Play here" />
            </View>
          ))}
        </ScrollView>
      )}
      <MatchReveal match={found} hostName={hostName} onPlayOnHost={() => found && playOnHost(found)} onPlayHere={() => { if (found) playItem(found.itemId, { restart: true }); setFound(null); }} onClose={() => setFound(null)} />
    </Screen>
  );
}

function Deck({ cards, onVote }: { cards: Item[]; onVote: (item: Item, v: MatchVote) => void }) {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const cardW = Math.min(width - t.space.gutter * 2, t.isTV ? t.s(380) : 360, (height - 330) * (2 / 3));
  const pos = useRef(new Animated.ValueXY()).current;
  const top = cards[0];
  const topRef = useRef(top);
  topRef.current = top;
  const fling = useCallback((v: MatchVote) => {
    const item = topRef.current;
    if (!item) return;
    const to = v === 'super' ? { x: 0, y: -height } : { x: (v === 'yes' ? 1 : -1) * width * 1.5, y: 40 };
    Animated.timing(pos, { toValue: to, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(() => {
      pos.setValue({ x: 0, y: 0 });
      onVote(item, v);
    });
  }, [pos, width, height, onVote]);
  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
    onPanResponderMove: Animated.event([null, { dx: pos.x, dy: pos.y }], { useNativeDriver: false }),
    onPanResponderRelease: (_e, g) => {
      const v = swipeVote(g.dx, g.dy, g.vx, g.vy, cardW);
      if (v) fling(v);
      else Animated.spring(pos, { toValue: { x: 0, y: 0 }, friction: 5, tension: 60, useNativeDriver: false }).start();
    },
  }), [pos, cardW, fling]);
  const rotate = pos.x.interpolate({ inputRange: [-cardW, 0, cardW], outputRange: ['-18deg', '0deg', '18deg'] });
  const yes = pos.x.interpolate({ inputRange: [0, cardW * 0.3], outputRange: [0, 1], extrapolate: 'clamp' });
  const no = pos.x.interpolate({ inputRange: [-cardW * 0.3, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const sup = pos.y.interpolate({ inputRange: [-cardW * 0.3, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  if (!top) return null;
  const next = cards[1];
  const meta = [top.year, top.contentRating, top.communityRating ? `★ ${top.communityRating.toFixed(1)}` : null].filter(Boolean).join(' · ');
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.space.md }}>
      <View style={{ width: cardW, aspectRatio: 2 / 3 }}>
        {next && (
          <View style={{ ...FILL, transform: [{ scale: 0.95 }, { translateY: 12 }], borderRadius: t.radius * 1.5, overflow: 'hidden', opacity: 0.8 }}>
            <Img path={next.posterUrl} width={cardW} style={{ width: '100%', height: '100%' }} />
          </View>
        )}
        <Animated.View {...responder.panHandlers} style={{ ...FILL, borderRadius: t.radius * 1.5, overflow: 'hidden', backgroundColor: t.alpha(t.colors.text, 0.08), transform: [{ translateX: pos.x }, { translateY: pos.y }, { rotate }] }}>
          <Img path={top.posterUrl} width={cardW} style={{ width: '100%', height: '100%' }} />
          <Animated.View style={{ position: 'absolute', top: 24, left: 20, opacity: yes, transform: [{ rotate: '-14deg' }], borderWidth: 4, borderColor: t.colors.success, borderRadius: 10, paddingHorizontal: 10 }}><T variant="title" color={t.colors.success}>YES</T></Animated.View>
          <Animated.View style={{ position: 'absolute', top: 24, right: 20, opacity: no, transform: [{ rotate: '14deg' }], borderWidth: 4, borderColor: t.colors.danger, borderRadius: 10, paddingHorizontal: 10 }}><T variant="title" color={t.colors.danger}>NOPE</T></Animated.View>
          <Animated.View style={{ position: 'absolute', bottom: '40%', alignSelf: 'center', opacity: sup, borderWidth: 4, borderColor: t.colors.accent, borderRadius: 10, paddingHorizontal: 10 }}><T variant="title" color={t.colors.accent}>SUPER</T></Animated.View>
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, backgroundColor: 'rgba(0,0,0,0.65)' }}>
            <T variant="heading" color="#fff" numberOfLines={1}>{top.title}</T>
            {meta ? <T variant="small" color="#ddd">{meta}</T> : null}
            {top.overview ? <T variant="small" color="#ddd" numberOfLines={2}>{top.overview}</T> : null}
          </View>
        </Animated.View>
      </View>
      <View style={{ flexDirection: 'row', gap: t.space.lg, alignItems: 'center' }}>
        <RoundButton icon="close" color={t.colors.danger} label="No" onPress={() => fling('no')} />
        <RoundButton icon="star" color={t.colors.accent} label="Super like" onPress={() => fling('super')} small />
        <RoundButton icon="heart" color={t.colors.success} label="Yes" onPress={() => fling('yes')} preferred />
      </View>
    </View>
  );
}

function RoundButton({ icon, color, label, onPress, small, preferred }: { icon: React.ComponentProps<typeof Icon>['name']; color: string; label: string; onPress: () => void; small?: boolean; preferred?: boolean }) {
  const t = useTheme();
  const size = (small ? 52 : 64) * (t.isTV ? 1.25 : 1);
  return (
    <Focusable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hasTVPreferredFocus={preferred} ringRadius={size / 2}
      style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: color, alignItems: 'center', justifyContent: 'center', backgroundColor: t.alpha(t.colors.text, 0.06) }}>
      <Icon name={icon} size={size * 0.45} color={color} />
    </Focusable>
  );
}

const CONFETTI = 36;
function MatchReveal({ match, hostName, onPlayOnHost, onPlayHere, onClose }: { match: MatchResult | null; hostName: string | null; onPlayOnHost: () => void; onPlayHere: () => void; onClose: () => void }) {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const pop = useRef(new Animated.Value(0)).current;
  const fall = useRef(new Animated.Value(0)).current;
  const pieces = useMemo(() => Array.from({ length: CONFETTI }, (_, i) => ({
    x: Math.random() * width, drift: (Math.random() - 0.5) * 120, delay: Math.random() * 0.3, size: 6 + Math.random() * 6,
    color: [t.colors.primary, t.colors.accent, t.colors.success, t.colors.warning][i % 4], spin: `${Math.round(Math.random() * 720)}deg`,
  })), [match?.itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!match) return;
    pop.setValue(0);
    fall.setValue(0);
    Animated.parallel([
      Animated.spring(pop, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }),
      Animated.timing(fall, { toValue: 1, duration: 2600, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start();
  }, [match?.itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal visible={!!match} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center', justifyContent: 'center', padding: t.space.gutter, gap: t.space.md }}>
        {pieces.map((p, i) => (
          <Animated.View key={i} pointerEvents="none" style={{
            position: 'absolute', top: -20, left: p.x, width: p.size, height: p.size * 0.5, backgroundColor: p.color,
            transform: [
              { translateY: fall.interpolate({ inputRange: [0, 1], outputRange: [0, height + 40] }) },
              { translateX: fall.interpolate({ inputRange: [0, 1], outputRange: [0, p.drift] }) },
              { rotate: fall.interpolate({ inputRange: [0, 1], outputRange: ['0deg', p.spin] }) },
            ],
          }} />
        ))}
        <Animated.View style={{ transform: [{ scale: pop }], alignItems: 'center', gap: t.space.md }}>
          <T variant="hero" tone="primary" center>It's a match!</T>
          {match && <Img path={match.posterUrl} width={200} style={{ width: 180, aspectRatio: 2 / 3, borderRadius: t.radius * 1.5 }} />}
          {match && <T variant="heading" center>{match.title}{match.year ? ` (${match.year})` : ''}</T>}
        </Animated.View>
        <View style={{ gap: t.space.sm, width: '100%', maxWidth: 360 }}>
          {hostName ? <Button label={`Play on ${hostName}`} icon="tv-outline" size="lg" block onPress={onPlayOnHost} hasTVPreferredFocus /> : null}
          <Button label={hostName ? 'Play here' : 'Play now'} icon="play" size="lg" block variant={hostName ? 'secondary' : 'primary'} onPress={onPlayHere} hasTVPreferredFocus={!hostName} />
          <Button label="Keep swiping" variant="ghost" block onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
