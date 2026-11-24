/**
 * Random marathon + sleep timer + "Are you still watching?" for the native video player.
 *
 * - Marathon (`/player/<id>?marathon=<mid>`): when a title ends the server hands out the next random pick and the
 *   player's existing Up-next card counts down 10 s (VideoPlayerScreen renders `card`).
 * - Still watching: after N titles in a row / N hours without touching the player (server rule at title
 *   boundaries, checked here mid-title). Unanswered for 60 s → pause (position saved, not marked watched) and close.
 * - Sleep timer: 30/60/90 min, end of this title, after N titles; audio fades out over the last 30 s.
 *
 * Counters and the sleep timer live at module level so they survive the player remounting for the next title.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, View } from 'react-native';
import { router } from 'expo-router';
import type { Item } from '@/api/types';
import type { MediaMaxClient } from '@/api/client';
import { decide, stillWatchingDue } from '@/api/decide';
import type { SheetOption } from '@/components/OptionSheet';
import { Button } from '@/components/Button';
import { T } from '@/components/Text';
import { useTheme } from '@/theme';

/** "Are you still watching?" settings for this app session (toggled from the sleep sheet). */
export const STILL = { enabled: true, afterItems: 2, afterMinutes: 240 };
const FADE_MS = 30_000;
const ANSWER_S = 60;

type Sleep = { kind: 'minutes'; until: number; minutes: number } | { kind: 'end' } | { kind: 'items'; left: number };
let sleepState: Sleep | null = null;
const counters = new Map<string, { items: number; lastInput: number }>();

export const marathonHref = (itemId: string, marathonId: string) => `/player/${itemId}?start=0&marathon=${encodeURIComponent(marathonId)}`;

interface PlayerLike { volume: number; pause: () => void }

export function useMarathon(opts: {
  api: MediaMaxClient; marathonId: string | null; itemId: string | null; itemType: string | null; pos: number; dur: number; playing: boolean;
  player: PlayerLike; report: (s: 'paused' | 'stopped') => void; exit: () => void;
}) {
  const { api, marathonId, itemId, pos, dur, playing, player, report, exit } = opts;
  const [sleep, setSleepS] = useState<Sleep | null>(sleepState);
  const [card, setCard] = useState<{ item: Item; seconds: number } | null>(null);
  const [asking, setAsking] = useState<{ left: number; boundary: boolean } | null>(null);
  const baseVol = useRef<number | null>(null);
  const handled = useRef(false);
  const c = marathonId ? counters.get(marathonId) ?? { items: 0, lastInput: Date.now() } : { items: 0, lastInput: Date.now() };
  if (marathonId && !counters.has(marathonId)) counters.set(marathonId, c);

  const setSleep = (s: Sleep | null) => {
    sleepState = s;
    setSleepS(s);
    if (!s && baseVol.current != null) {
      player.volume = baseVol.current;
      baseVol.current = null;
    }
  };

  const noteInput = useCallback(() => {
    if (!marathonId) return;
    counters.set(marathonId, { items: 0, lastInput: Date.now() });
  }, [marathonId]);

  const stop = useCallback(() => {
    try {
      player.pause();
    } catch {
      /* released */
    }
    if (baseVol.current != null) player.volume = baseVol.current;
    baseVol.current = null;
    sleepState = null;
    report('paused'); // position saved; not marked watched
    if (marathonId) void decide(api).endMarathon(marathonId).catch(() => undefined);
    setAsking(null);
    setCard(null);
    exit();
  }, [player, report, marathonId, api, exit]);

  // Sleep timer: fade and stop.
  useEffect(() => {
    if (!sleep) return;
    const remaining = dur > 0 ? dur - pos : null;
    const left = sleep.kind === 'minutes' ? sleep.until - Date.now() : sleep.kind === 'end' || (sleep.kind === 'items' && sleep.left <= 1) ? remaining : null;
    if (left == null) return;
    if (left < FADE_MS) {
      if (baseVol.current == null) baseVol.current = player.volume;
      player.volume = Math.max(0, baseVol.current * Math.max(0, left / FADE_MS));
    }
    if (left <= 0) stop();
  }, [pos, sleep, dur, player, stop]);

  // Mid-title idle check.
  useEffect(() => {
    if (!marathonId || !playing || asking) return;
    const iv = setInterval(() => {
      const cur = counters.get(marathonId);
      if (cur && stillWatchingDue(STILL, 0, Date.now() - cur.lastInput)) setAsking({ left: ANSWER_S, boundary: false });
    }, 30000);
    return () => clearInterval(iv);
  }, [marathonId, playing, asking]);

  useEffect(() => {
    if (!asking) return;
    if (asking.left <= 0) return stop();
    const tm = setTimeout(() => setAsking((a) => (a ? { ...a, left: a.left - 1 } : a)), 1000);
    return () => clearTimeout(tm);
  }, [asking, stop]);

  const play = useCallback(() => {
    if (!card || !marathonId) return;
    report('stopped');
    router.replace(marathonHref(card.item.id, marathonId) as never);
  }, [card, marathonId, report]);

  useEffect(() => {
    if (!card || asking) return;
    if (card.seconds <= 0) return play();
    const tm = setTimeout(() => setCard((x) => (x ? { ...x, seconds: x.seconds - 1 } : x)), 1000);
    return () => clearTimeout(tm);
  }, [card, asking, play]);

  /** Call when the title ends. Returns true when the marathon / sleep timer took over. */
  const onEnded = useCallback((): boolean => {
    if (handled.current) return true;
    if (sleepState?.kind === 'end' || (sleepState?.kind === 'items' && sleepState.left <= 1)) {
      handled.current = true;
      stop();
      return true;
    }
    if (sleepState?.kind === 'items') setSleep({ kind: 'items', left: sleepState.left - 1 });
    if (!marathonId || !itemId) return false;
    handled.current = true;
    const cur = counters.get(marathonId) ?? { items: 0, lastInput: Date.now() };
    cur.items += 1;
    counters.set(marathonId, cur);
    decide(api).marathonNext(marathonId, { finishedItemId: itemId, itemsSinceInput: cur.items, msSinceInput: Date.now() - cur.lastInput })
      .then((r) => {
        if (!r.item) return exit();
        setCard({ item: r.item, seconds: 10 });
        if (r.stillWatchingCheck && STILL.enabled) setAsking({ left: ANSWER_S, boundary: true });
      })
      .catch(() => exit());
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marathonId, itemId, api, exit, stop]);

  const sleepOptions: SheetOption<string>[] = [
    { key: 'off', label: 'Off', selected: !sleep },
    ...[30, 60, 90].map((m) => ({ key: `m${m}`, label: `${m} minutes`, selected: sleep?.kind === 'minutes' && sleep.minutes === m })),
    { key: 'end', label: opts.itemType === 'episode' ? 'End of this episode' : 'End of this film', selected: sleep?.kind === 'end' },
    ...(marathonId ? [2, 3].map((n) => ({ key: `i${n}`, label: `After ${n} titles`, selected: sleep?.kind === 'items' && sleep.left === n })) : []),
    { key: 'sw', label: 'Ask "Are you still watching?"', description: `After ${STILL.afterItems} titles or ${STILL.afterMinutes / 60} h without input`, selected: STILL.enabled },
  ];
  const selectSleep = (k: string) => {
    if (k === 'sw') {
      STILL.enabled = !STILL.enabled;
      return setSleepS((s) => s);
    }
    if (k === 'off') return setSleep(null);
    if (k === 'end') return setSleep({ kind: 'end' });
    if (k[0] === 'm') return setSleep({ kind: 'minutes', until: Date.now() + Number(k.slice(1)) * 60_000, minutes: Number(k.slice(1)) });
    setSleep({ kind: 'items', left: Number(k.slice(1)) });
  };

  const stillWatching = (
    <StillWatching visible={!!asking} seconds={asking?.left ?? 0}
      onYes={() => { noteInput(); setAsking(null); }}
      onNo={stop} />
  );

  return {
    active: !!marathonId,
    card: asking ? null : card,
    play,
    cancel: () => { setCard(null); if (marathonId) void decide(api).endMarathon(marathonId).catch(() => undefined); },
    onEnded,
    noteInput,
    sleepOn: !!sleep,
    sleepOptions,
    selectSleep,
    stillWatching,
  };
}

function StillWatching({ visible, seconds, onYes, onNo }: { visible: boolean; seconds: number; onYes: () => void; onNo: () => void }) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onYes} supportedOrientations={['portrait', 'landscape']}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', alignItems: 'center', justifyContent: 'center', padding: t.space.gutter }}>
        <View style={{ backgroundColor: 'rgba(20,20,28,0.96)', borderRadius: t.radius * 1.5, padding: t.space.lg, gap: t.space.md, maxWidth: 420, width: '100%' }}>
          <T variant="title" color="#fff" center>Are you still watching?</T>
          <T tone="muted" center>We'll pause in {seconds} s so nothing streams all night.</T>
          <Button label="Keep watching" icon="play" block onPress={onYes} hasTVPreferredFocus />
          <Button label="Stop" variant="secondary" block onPress={onNo} />
        </View>
      </View>
    </Modal>
  );
}
