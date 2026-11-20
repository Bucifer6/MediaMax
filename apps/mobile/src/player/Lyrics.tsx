/** Lyrics for the now-playing track. Synced lyrics highlight and auto-scroll the current line. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import type { Lyrics } from '@/api/types';
import { Focusable } from '@/components/Focusable';
import { T } from '@/components/Text';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';

/** Fetch lyrics; `null` = none (404 or error), `undefined` = loading. */
export function useLyrics(itemId: string | null): Lyrics | null | undefined {
  const { api } = useSession();
  const [lyrics, setLyrics] = useState<Lyrics | null | undefined>(undefined);
  useEffect(() => {
    setLyrics(itemId ? undefined : null);
    if (!itemId || !api) return;
    const ctrl = new AbortController();
    api
      .lyrics(itemId, ctrl.signal)
      .then((l) => !ctrl.signal.aborted && setLyrics(l?.lines?.length ? l : null))
      .catch(() => !ctrl.signal.aborted && setLyrics(null));
    return () => ctrl.abort();
  }, [itemId, api]);
  return lyrics;
}

export function LyricsView({ lyrics, positionMs, onSeek }: { lyrics: Lyrics | null | undefined; positionMs: number; onSeek?: (ms: number) => void }) {
  const t = useTheme();
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const lineY = useRef<number[]>([]);
  const [height, setHeight] = useState(0);
  const userScrolledAt = useRef(0);

  const synced = !!lyrics?.synced;
  const active = useMemo(() => {
    if (!lyrics || !synced) return -1;
    let idx = -1;
    lyrics.lines.forEach((l, i) => {
      if (l.startMs != null && l.startMs <= positionMs + 250) idx = i;
    });
    return idx;
  }, [lyrics, synced, positionMs]);

  // Keep the active line about a third of the way down, unless the user just scrolled.
  useEffect(() => {
    if (active < 0 || Date.now() - userScrolledAt.current < 4000) return;
    const y = lineY.current[active];
    if (y == null) return;
    scroller.current?.scrollTo({ y: Math.max(0, y - height / 3), animated: true });
  }, [active, height]);

  if (lyrics === undefined) return <ActivityIndicator color="#fff" style={{ marginTop: t.space.xl }} />;
  if (!lyrics)
    return (
      <T color="rgba(255,255,255,0.7)" center style={{ marginTop: t.space.xl }}>
        No lyrics for this track.
      </T>
    );

  const size = t.isTV ? t.s(30) : t.wide ? 26 : 22;
  return (
    <ScrollView
      ref={scroller}
      style={{ flex: 1 }}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      onScrollBeginDrag={() => (userScrolledAt.current = Date.now())}
      contentContainerStyle={{ paddingVertical: t.space.lg, paddingBottom: height / 2, gap: t.isTV ? t.s(12) : 10 }}
      showsVerticalScrollIndicator={false}
    >
      {lyrics.lines.map((l, i) => {
        const isActive = i === active;
        const style = { fontSize: size, lineHeight: size * 1.35, fontWeight: '800' as const, color: !synced ? '#fff' : isActive ? '#fff' : i < active ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.6)' };
        const text = l.text.trim() ? l.text : '♪';
        return (
          <View key={i} onLayout={(e) => (lineY.current[i] = e.nativeEvent.layout.y)}>
            {synced && onSeek && l.startMs != null ? (
              // Tap (or select on TV) a line to jump there.
              <Focusable onPress={() => onSeek(l.startMs!)} focusScale={t.isTV ? 1.03 : 1} ring={false} style={{ paddingVertical: 2 }}>
                {({ focused }) => <T style={[style, focused ? { color: t.colors.primary } : null]}>{text}</T>}
              </Focusable>
            ) : (
              <T style={style}>{text}</T>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}
