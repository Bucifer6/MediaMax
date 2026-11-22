/**
 * Lyrics for the now-playing track. Synced lyrics highlight and auto-scroll the current line, with karaoke
 * word-by-word highlighting (enhanced LRC / SYLT word timing, or a wipe across the line when only line times exist).
 * The user can nudge the timing per track (saved on the server, added to their global offset), and switch to the
 * server's karaoke mix when the track has AI stems (prepared in the web app).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import type { Lyrics, StemsJob, StemsStatus, TrackStems } from '@/api/types';
import { Chip } from '@/components/Chip';
import { Focusable } from '@/components/Focusable';
import { T } from '@/components/Text';
import { useMusic } from '@/state/music';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { lyricStateAt, wordFills, type LrcLine } from './lrc';

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

/**
 * Smooth playback clock: the player reports its position a few times a second; between reports the time is
 * extrapolated so the karaoke wipe moves continuously.
 */
function useSmoothTime(positionMs: number, playing: boolean, stepMs = 60): number {
  const base = useRef({ pos: positionMs, at: Date.now() });
  const [now, setNow] = useState(positionMs);
  useEffect(() => {
    base.current = { pos: positionMs, at: Date.now() };
    setNow(positionMs);
  }, [positionMs]);
  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => setNow(base.current.pos + Math.min(1500, Date.now() - base.current.at)), stepMs);
    return () => clearInterval(iv);
  }, [playing, stepMs]);
  return now;
}

/** The current line, word by word: sung words in the theme colour, the word being sung fading in. */
function KaraokeLine({ line, lines, timeMs, size, color }: { line: LrcLine; lines: LrcLine[]; timeMs: number; size: number; color: string }) {
  const st = lyricStateAt(lines, timeMs);
  const fills = st.line === line ? wordFills(line, st) : wordFills(line, { progress: 0, wordIndex: -1, wordProgress: 0 });
  return (
    <T style={{ fontSize: size, lineHeight: size * 1.35, fontWeight: '800', color: '#fff' }}>
      {fills.map((w, i) => (
        <T key={i} style={{ fontSize: size, lineHeight: size * 1.35, fontWeight: '800', color: w.fill >= 1 ? color : '#fff', opacity: w.fill > 0 && w.fill < 1 ? 0.55 + 0.45 * w.fill : 1 }}>
          {w.text}
        </T>
      ))}
    </T>
  );
}

export function LyricsView({ lyrics, positionMs, onSeek }: { lyrics: Lyrics | null | undefined; positionMs: number; onSeek?: (ms: number) => void }) {
  const t = useTheme();
  const m = useMusic();
  const { api, user } = useSession();
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const lineY = useRef<number[]>([]);
  const [height, setHeight] = useState(0);
  const userScrolledAt = useRef(0);
  const [trackOffset, setTrackOffset] = useState(0);
  useEffect(() => setTrackOffset(lyrics?.userOffsetMs ?? 0), [lyrics]);
  const offset = trackOffset + (user?.preferences.lyricsOffsetMs ?? 0);
  const smooth = useSmoothTime(positionMs, m.playing);
  const timeMs = Math.max(0, smooth + offset);
  const lines = useMemo(() => (lyrics?.lines ?? []) as LrcLine[], [lyrics]);

  const synced = !!lyrics?.synced;
  const active = useMemo(() => (synced ? lyricStateAt(lines, timeMs).index : -1), [lines, synced, timeMs]);

  // Keep the active line about a third of the way down, unless the user just scrolled.
  useEffect(() => {
    if (active < 0 || Date.now() - userScrolledAt.current < 4000) return;
    const y = lineY.current[active];
    if (y == null) return;
    scroller.current?.scrollTo({ y: Math.max(0, y - height / 3), animated: true });
  }, [active, height]);

  const nudge = (d: number) => {
    if (!lyrics || !api) return;
    const next = trackOffset + d;
    setTrackOffset(next);
    api.setLyricsOffset(lyrics.itemId, next).catch(() => undefined);
  };

  if (lyrics === undefined) return <ActivityIndicator color="#fff" style={{ marginTop: t.space.xl }} />;
  if (!lyrics)
    return (
      <View style={{ flex: 1 }}>
        <T color="rgba(255,255,255,0.7)" center style={{ marginTop: t.space.xl }}>
          No lyrics for this track.
        </T>
        <KaraokeBar itemId={m.current?.type === 'track' ? m.current.id : null} />
      </View>
    );

  const size = t.isTV ? t.s(30) : t.wide ? 26 : 22;
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
        onScrollBeginDrag={() => (userScrolledAt.current = Date.now())}
        contentContainerStyle={{ paddingVertical: t.space.lg, paddingBottom: height / 2, gap: t.isTV ? t.s(12) : 10 }}
        showsVerticalScrollIndicator={false}
      >
        {lines.map((l, i) => {
          const isActive = i === active;
          const style = { fontSize: size, lineHeight: size * 1.35, fontWeight: '800' as const, color: !synced ? '#fff' : isActive ? '#fff' : i < active ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.6)' };
          const text = l.text.trim() ? l.text : '♪';
          return (
            <View key={i} onLayout={(e) => (lineY.current[i] = e.nativeEvent.layout.y)}>
              {synced && onSeek && l.startMs != null ? (
                // Tap (or select on TV) a line to jump there.
                <Focusable onPress={() => onSeek(Math.max(0, l.startMs! - offset))} focusScale={t.isTV ? 1.03 : 1} ring={false} style={{ paddingVertical: 2 }}>
                  {({ focused }) =>
                    isActive && l.text.trim() ? (
                      <KaraokeLine line={l} lines={lines} timeMs={timeMs} size={size} color={t.colors.primary} />
                    ) : (
                      <T style={[style, focused ? { color: t.colors.primary } : null]}>{text}</T>
                    )
                  }
                </Focusable>
              ) : (
                <T style={style}>{text}</T>
              )}
            </View>
          );
        })}
      </ScrollView>
      {synced ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.sm, paddingTop: t.space.sm }}>
          <T variant="small" color="rgba(255,255,255,0.65)">Timing</T>
          <Chip label="−0.1s" onPress={() => nudge(-100)} />
          <T variant="small" weight="700" color="#fff">{offset > 0 ? '+' : ''}{(offset / 1000).toFixed(1)}s</T>
          <Chip label="+0.1s" onPress={() => nudge(100)} />
        </View>
      ) : null}
      <KaraokeBar itemId={lyrics.itemId} />
    </View>
  );
}

const VOCAL_LEVELS = [0, 15, 30];

const JOB_PHASE: Record<StemsJob['phase'], string> = {
  waiting: 'Waiting for the server', 'runtime-download': 'Downloading the AI runtime', 'model-download': 'Downloading the AI model',
  'loading-model': 'Loading the AI model', decoding: 'Decoding the track', separating: 'Separating vocals', saving: 'Saving stems',
};

/**
 * Karaoke on the phone / Android TV: plays the server's karaoke mix when the track has AI stems. When the server
 * separates (StemsStatus.engine 'server'), an administrator can prepare the track from here and follow the job;
 * otherwise preparing happens in the web app on a computer.
 */
export function KaraokeBar({ itemId }: { itemId: string | null }) {
  const t = useTheme();
  const m = useMusic();
  const { api, user } = useSession();
  const [stems, setStems] = useState<TrackStems | null>(null);
  const [status, setStatus] = useState<StemsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setStems(null);
    setError(null);
    if (!itemId || !api) return;
    let off = false;
    api.trackStems(itemId).then((s) => !off && setStems(s)).catch(() => undefined);
    if (user?.isAdmin) api.stemsStatus().then((s) => !off && setStatus(s)).catch(() => undefined);
    return () => {
      off = true;
    };
  }, [itemId, api, user?.isAdmin]);
  // Follow a server job while one is queued / running.
  const job = stems?.job ?? null;
  useEffect(() => {
    if (!job || !itemId || !api) return;
    const tm = setTimeout(() => {
      api.trackStems(itemId).then((s) => {
        setStems(s);
        if (!s.job && !s.ready && s.error) setError(s.error);
      }).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(tm);
  }, [job, itemId, api, stems]);
  if (!itemId || !api) return null;
  if (!stems?.ready) {
    const canServer = !!status?.canPrepare && status.engine === 'server';
    if (job) {
      const pct = job.total ? ` · ${Math.round((job.done / job.total) * 100)}%` : '';
      return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: t.space.sm, paddingTop: t.space.sm }}>
          <ActivityIndicator size="small" color="#fff" />
          <T variant="small" color="rgba(255,255,255,0.75)">{JOB_PHASE[job.phase] ?? 'Preparing'}{pct}</T>
          {canServer ? <Chip icon="close-outline" label="Cancel" selected={false} onPress={() => api.cancelStemsOnServer(itemId).then(() => api.trackStems(itemId)).then(setStems).catch(() => undefined)} /> : null}
        </View>
      );
    }
    if (canServer) {
      return (
        <View style={{ alignItems: 'center', gap: t.space.xs, paddingTop: t.space.sm }}>
          <Chip icon="color-wand-outline" label="Prepare karaoke (AI)" selected={false} onPress={() => {
            setError(null);
            api.prepareStemsOnServer(itemId).then(setStems).catch((e: Error) => setError(e.message));
          }} />
          {error || stems?.error ? <T variant="small" center color="#ff8a80">{error || stems?.error}</T> : null}
        </View>
      );
    }
    return (
      <T variant="small" center color="rgba(255,255,255,0.55)" style={{ paddingTop: t.space.sm }}>
        Karaoke: prepare this track in the web app on a computer (Prepare (AI)), then sing along here.
      </T>
    );
  }
  const preferred = user?.preferences.karaokeVocalLevel ?? 15;
  const on = !!m.altSource;
  const level = on ? Number(/vocals=(\d+)/.exec(m.altSource!)?.[1] ?? preferred) : null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: t.space.sm, paddingTop: t.space.sm }}>
      <Chip icon="mic-outline" label={on ? 'Karaoke on' : 'Karaoke'} selected={on} onPress={() => m.setAltSource(on ? null : api.karaokeMixPath(itemId, preferred))} />
      {on
        ? VOCAL_LEVELS.map((v) => (
            <Chip key={v} label={v === 0 ? 'No vocals' : `Vocals ${v}%`} selected={level === v} onPress={() => m.setAltSource(api.karaokeMixPath(itemId, v))} />
          ))
        : null}
    </View>
  );
}
