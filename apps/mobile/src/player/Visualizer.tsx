/**
 * Music visualiser for Now Playing (phones and TVs): a ring and glow that pulse around the artwork on every beat, and
 * a row of spectrum bars that kick on the beat and shimmer on the half-beats.
 *
 * It follows the track's beat grid from the server (src/player/beat.ts) rather than the live audio, because Android
 * only hands out audio samples with the microphone permission. Every movement is a native-driver animation started
 * once per (half-)beat, so the JS thread does a few calls a second and the Fire TV stick stays smooth.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, View, type LayoutChangeEvent } from 'react-native';
import { Img } from '@/components/Img';
import { useMusic } from '@/state/music';
import { useTheme } from '@/theme';
import { barLevels, beatGrid, nextBeat, type BeatGrid } from './beat';

const BARS = 32;
const REST = 0.06;

export function Visualizer({ art }: { art?: string | null }) {
  const t = useTheme();
  const m = useMusic();
  const itemId = m.current?.id ?? null;
  const playing = m.playing;
  const [grid, setGrid] = useState<BeatGrid>(() => beatGrid(null));
  const [reduceMotion, setReduceMotion] = useState(false);
  /** The space we were given (a side panel on TV, the screen width on phones): disc and bars are sized to fit. */
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!box || Math.abs(box.w - width) > 2 || Math.abs(box.h - height) > 2) setBox({ w: width, h: height });
  };

  const bars = useMemo(() => Array.from({ length: BARS }, () => new Animated.Value(REST)), []);
  const ring = useRef(new Animated.Value(0)).current;

  // Where the track is now, estimated between the player's 250 ms status updates.
  const pos = useRef({ ms: m.positionMs, at: Date.now(), playing });
  pos.current = { ms: m.positionMs, at: Date.now(), playing };
  const nowMs = () => pos.current.ms + (pos.current.playing ? Date.now() - pos.current.at : 0);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    setGrid(beatGrid(null));
    if (!itemId) return;
    let alive = true;
    void m.analysisFor(itemId).then((a) => alive && setGrid(beatGrid(a)));
    return () => {
      alive = false;
    };
  }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const settle = () => {
      for (const b of bars) Animated.timing(b, { toValue: REST, duration: 400, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
      Animated.timing(ring, { toValue: 0, duration: 400, useNativeDriver: true }).start();
    };
    if (!playing || !itemId) {
      settle();
      return;
    }
    const g: BeatGrid = reduceMotion ? { ...grid, steady: false, energy: Math.min(grid.energy, 0.3) } : grid;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const hit = (index: number, offbeat: boolean) => {
      const span = g.steady ? (offbeat ? g.beatMs * 0.45 : g.beatMs * 0.85) : g.beatMs * 0.9;
      const attack = g.steady ? 70 : g.beatMs * 0.4;
      const levels = barLevels(BARS, g.energy, index, offbeat);
      bars.forEach((b, i) => {
        Animated.sequence([
          Animated.timing(b, { toValue: levels[i]!, duration: attack, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(b, { toValue: REST, duration: Math.max(80, span - attack), easing: Easing.in(Easing.quad), useNativeDriver: true }),
        ]).start();
      });
      if (!offbeat) {
        Animated.sequence([
          Animated.timing(ring, { toValue: g.steady ? g.energy : 0.35, duration: attack, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(ring, { toValue: 0, duration: Math.max(80, span - attack), easing: Easing.in(Easing.quad), useNativeDriver: true }),
        ]).start();
      }
    };

    // Re-read the position before every (half-)beat, so seeks, pauses and slow status updates don't make it drift.
    const schedule = () => {
      if (stopped) return;
      const { inMs, index } = nextBeat(nowMs(), g);
      const half = g.beatMs / 2;
      const offbeatFirst = g.steady && inMs > half + 20;
      const wait = offbeatFirst ? inMs - half : inMs;
      timer = setTimeout(() => {
        if (stopped) return;
        hit(offbeatFirst ? index - 1 : index, offbeatFirst);
        schedule();
      }, Math.max(16, wait));
    };
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [playing, itemId, grid, reduceMotion, bars, ring]); // eslint-disable-line react-hooks/exhaustive-deps

  const w = box?.w ?? (t.isTV ? t.s(600) : t.width);
  const h = box?.h ?? (t.isTV ? t.s(700) : 480);
  // Disc + glow (1.5x) and the bars stacked: disc ~55% of the height, bars ~25%, both inside the width.
  const disc = Math.max(80, Math.min(t.isTV ? t.s(260) : 200, (w * 0.9) / 1.5, (h * 0.55) / 1.5));
  const barH = Math.max(40, Math.min(t.isTV ? t.s(150) : 110, h * 0.25));
  const barW = Math.max(3, Math.min(t.isTV ? t.s(9) : 6, (w * 0.9) / (BARS * 1.6)));
  const glowOpacity = ring.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.55] });
  const glowScale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const ringScale = ring.interpolate({ inputRange: [0, 1], outputRange: [1.04, 1.2] });
  const ringOpacity = ring.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.95] });
  const artScale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] });

  return (
    <View onLayout={onLayout} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: Math.min(t.isTV ? t.s(48) : 32, h * 0.06), overflow: 'hidden' }} accessibilityLabel="Music visualiser" accessible>
      <View style={{ width: disc * 1.5, height: disc * 1.5, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={{ position: 'absolute', width: disc, height: disc, borderRadius: disc / 2, backgroundColor: t.colors.primary, opacity: glowOpacity, transform: [{ scale: glowScale }] }} />
        <Animated.View style={{ position: 'absolute', width: disc, height: disc, borderRadius: disc / 2, borderWidth: t.isTV ? t.s(4) : 3, borderColor: t.colors.primary, opacity: ringOpacity, transform: [{ scale: ringScale }] }} />
        <Animated.View style={{ width: disc, height: disc, borderRadius: disc / 2, overflow: 'hidden', backgroundColor: '#222', transform: [{ scale: artScale }] }}>
          {art ? <Img path={art} width={Math.round(disc)} style={{ width: '100%', height: '100%' }} /> : null}
        </Animated.View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: barH, gap: barW * 0.6 }}>
        {bars.map((b, i) => (
          <Animated.View
            key={i}
            style={{
              width: barW,
              height: barH,
              borderRadius: barW / 2,
              backgroundColor: i % 2 ? t.colors.primary : t.alpha(t.colors.primary, 0.75),
              transformOrigin: 'bottom',
              transform: [{ scaleY: b }],
            }}
          />
        ))}
      </View>
    </View>
  );
}
