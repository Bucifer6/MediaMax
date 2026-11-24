import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, ScrollView, Vibration, View } from 'react-native';
import type { Item, PairedTarget, RemoteAction, RemoteKey, RemotePlayerState, RemoteTarget, SecondScreenInfo, SongIdResponse } from '@/api/types';
import { Button } from '@/components/Button';
import { Icon, type IconName } from '@/components/Icon';
import { Img } from '@/components/Img';
import { Input } from '@/components/Input';
import { Screen, ScreenHeader } from '@/components/Screen';
import { T } from '@/components/Text';
import { Scrubber } from '@/player/Scrubber';
import { useApi, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { formatClock } from '@/utils/format';

/**
 * Phone remote for a TV running the web app (TV mode): touch-pad (swipe = D-pad, tap = OK), back / home / play-pause /
 * ±10 s / volume, a keyboard field that types into the TV's focused input, a second screen while it plays (scrubber
 * with trickplay, chapters, skip, audio / subtitles, cast, episodes, up next, "What's this song?" from the playing
 * file) and "Play on TV" browsing. Touch-pad keys need a QR pairing (`remote.key` is only routed to paired TVs).
 * The microphone song-ID fallback is web only (the app does not request microphone access).
 */

interface Target {
  id: string;
  name: string;
  ownerName: string | null;
  paired: boolean;
  pairingId: string | null;
  crossUser: boolean;
  online: boolean;
  state: RemotePlayerState | null;
}

const TAP_SLOP = 14;
const SWIPE_STEP = 64;

function merge(own: RemoteTarget[], paired: PairedTarget[]): Target[] {
  const out = new Map<string, Target>();
  for (const t of own) out.set(t.id, { id: t.id, name: t.deviceName, ownerName: null, paired: false, pairingId: null, crossUser: false, online: true, state: t.state });
  for (const p of paired) {
    const prev = out.get(p.id);
    out.set(p.id, { id: p.id, name: p.deviceName, ownerName: p.crossUser ? p.ownerName : null, paired: true, pairingId: p.pairingId, crossUser: p.crossUser, online: p.online || !!prev, state: p.state ?? prev?.state ?? null });
  }
  return [...out.values()].sort((a, b) => Number(b.paired) - Number(a.paired));
}

export default function TvRemoteScreen() {
  const api = useApi();
  const { socket } = useSession();
  const params = useLocalSearchParams<{ device?: string }>();
  const [own, setOwn] = useState<RemoteTarget[]>([]);
  const [paired, setPaired] = useState<PairedTarget[]>([]);
  const [loaded, setLoaded] = useState(false);
  const received = useRef(new Map<string, number>());

  const load = useCallback(async () => {
    const [o, p] = await Promise.all([api.get<RemoteTarget[]>('/remote/targets').catch(() => []), api.get<PairedTarget[]>('/pair/targets').catch(() => [])]);
    const now = Date.now();
    [...o, ...p].forEach((t) => received.current.set(t.id, now));
    setOwn(o);
    setPaired(p);
    setLoaded(true);
  }, [api]);
  useEffect(() => {
    void load();
    return socket?.subscribe((ev) => {
      if (ev.type === 'remote.targets') void load();
      else if (ev.type === 'pair.targets') {
        const now = Date.now();
        ev.targets.forEach((t) => received.current.set(t.id, now));
        setPaired(ev.targets);
      } else if (ev.type === 'pair.updated' && ev.status === 'revoked') void load();
    });
  }, [socket, load]);

  const targets = useMemo(() => merge(own, paired), [own, paired]);
  const chosen = typeof params.device === 'string' && params.device ? targets.find((x) => x.id === params.device) : targets.length === 1 || (targets[0]?.paired && !targets[1]?.paired) ? targets[0] : undefined;

  if (!chosen) return <TargetList targets={targets} loaded={loaded} />;
  return <Remote target={chosen} receivedAt={received.current.get(chosen.id) ?? Date.now()} onChanged={load} />;
}

function TargetList({ targets, loaded }: { targets: Target[]; loaded: boolean }) {
  const t = useTheme();
  return (
    <Screen>
      <ScreenHeader title="Remote" />
      <ScrollView contentContainerStyle={{ padding: t.space.gutter, gap: t.space.md }}>
        {loaded && !targets.length ? <T tone="muted">No TVs yet. On the TV choose “Use your phone as remote”, then pair with the code.</T> : null}
        {targets.map((x) => (
          <Pressable key={x.id} onPress={() => router.setParams({ device: x.id })} style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'center', padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface }}>
            <Icon name="tv-outline" size={24} color={t.colors.text} />
            <View style={{ flex: 1 }}>
              <T weight="700">{x.name}</T>
              <T variant="small" tone="muted">{[x.ownerName && `${x.ownerName}’s TV`, x.paired ? 'Paired' : 'Your device', x.online ? (x.state?.title ? `Playing ${x.state.title}` : 'Online') : 'Offline'].filter(Boolean).join(' · ')}</T>
            </View>
            <Icon name="chevron-forward" size={18} color={t.colors.textMuted} />
          </Pressable>
        ))}
        <Button label="Pair a TV" icon="link" onPress={() => router.push('/pair')} block size="lg" />
      </ScrollView>
    </Screen>
  );
}

type Tab = 'remote' | 'now' | 'browse';

function Remote({ target, receivedAt, onChanged }: { target: Target; receivedAt: number; onChanged: () => void }) {
  const t = useTheme();
  const api = useApi();
  const { socket } = useSession();
  const st = target.state;
  const [tab, setTab] = useState<Tab>(st?.itemId ? 'now' : 'remote');
  const [notice, setNotice] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!st || st.paused) return;
    const i = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, [st]);
  const pos = st ? Math.min(st.durationMs ?? Infinity, st.positionMs + (st.paused ? 0 : Date.now() - receivedAt)) : 0;
  const say = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice((n) => (n === m ? null : n)), 2500);
  };

  const cmd = (action: RemoteAction, opts: { itemId?: string; positionMs?: number; volume?: number; trackIndex?: number | null } = {}) => {
    if (!socket?.connected) return say('Not connected');
    socket.send({ type: 'remote.command', targetDeviceId: target.id, action, ...opts });
    Vibration.vibrate(8);
  };
  const key = (k: RemoteKey, text?: string) => {
    if (!target.paired) return say('Pair this TV by QR code to use the touch-pad');
    if (!socket?.connected) return say('Not connected');
    socket.send({ type: 'remote.key', targetDeviceId: target.id, key: k, ...(text != null ? { text } : {}) });
  };

  const unpair = async () => {
    if (!target.pairingId) return;
    await api.del(`/pair/pairings/${encodeURIComponent(target.pairingId)}`).catch(() => undefined);
    onChanged();
    router.setParams({ device: '' });
  };

  return (
    <Screen>
      <ScreenHeader
        title={target.name}
        subtitle={target.online ? (target.crossUser ? `${target.ownerName}’s TV · guest` : 'Connected') : 'Offline'}
        right={target.pairingId ? <Button icon="close" variant="ghost" size="sm" accessibilityLabel="Unpair" onPress={unpair} /> : undefined}
      />
      <View style={{ flexDirection: 'row', gap: t.space.sm, paddingHorizontal: t.space.gutter, paddingBottom: t.space.sm }}>
        {(['remote', 'now', 'browse'] as Tab[]).map((x) => (
          <Pressable key={x} onPress={() => setTab(x)} accessibilityRole="tab" accessibilityState={{ selected: tab === x }}
            style={{ flex: 1, paddingVertical: 8, borderRadius: 999, alignItems: 'center', backgroundColor: tab === x ? t.colors.primary : t.colors.surface }}>
            <T weight="700" color={tab === x ? t.colors.primaryText : t.colors.text}>{x === 'remote' ? 'Remote' : x === 'now' ? 'Now playing' : 'Browse'}</T>
          </Pressable>
        ))}
      </View>
      {notice ? <T tone="warning" center>{notice}</T> : null}
      {tab === 'remote' && <Pad paired={target.paired} playing={!!st?.itemId} volume={st?.volume ?? null} onKey={key}
        onToggle={() => (st?.itemId ? cmd('togglePause') : key('playPause'))}
        onSeek={(d) => cmd('seek', { positionMs: Math.max(0, pos + d) })}
        onVolume={(d) => cmd('setVolume', { volume: Math.max(0, Math.min(100, (st?.volume ?? 50) + d)) })} />}
      {tab === 'now' && <SecondScreen target={target} pos={pos} cmd={cmd} />}
      {tab === 'browse' && <Browse target={target} onPlay={(it) => { cmd('playItem', { itemId: it.id }); say(`Playing ${it.title}`); setTab('now'); }} />}
    </Screen>
  );
}

function PadButton({ icon, label, onPress, big }: { icon: IconName; label: string; onPress: () => void; big?: boolean }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} accessibilityRole="button"
      style={({ pressed }) => ({ flex: 1, minHeight: big ? 76 : 62, borderRadius: t.radius + 4, alignItems: 'center', justifyContent: 'center', gap: 2,
        backgroundColor: big ? t.colors.primary : pressed ? t.colors.surfaceAlt : t.colors.surface, borderWidth: 1, borderColor: big ? 'transparent' : t.colors.border })}>
      <Icon name={icon} size={big ? 30 : 22} color={big ? t.colors.primaryText : t.colors.text} />
      <T variant="caption" color={big ? t.colors.primaryText : t.colors.textMuted}>{label}</T>
    </Pressable>
  );
}

function Pad({ paired, playing, volume, onKey, onToggle, onSeek, onVolume }: {
  paired: boolean; playing: boolean; volume: number | null; onKey: (k: RemoteKey, text?: string) => void; onToggle: () => void; onSeek: (ms: number) => void; onVolume: (d: number) => void;
}) {
  const t = useTheme();
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  const last = useRef({ dx: 0, dy: 0, emitted: false, t: 0 });
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      last.current = { dx: 0, dy: 0, emitted: false, t: Date.now() };
    },
    onPanResponderMove: (_e, g) => {
      const dx = g.dx - last.current.dx;
      const dy = g.dy - last.current.dy;
      const n = Math.floor(Math.max(Math.abs(dx), Math.abs(dy)) / SWIPE_STEP);
      if (!n) return;
      const k: RemoteKey = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      for (let i = 0; i < Math.min(n, 3); i++) keyRef.current(k);
      Vibration.vibrate(6);
      last.current = { ...last.current, dx: g.dx, dy: g.dy, emitted: true };
    },
    onPanResponderRelease: (_e, g) => {
      const dx = g.dx - last.current.dx;
      const dy = g.dy - last.current.dy;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (!last.current.emitted && ax < TAP_SLOP && ay < TAP_SLOP) {
        if (Date.now() - last.current.t < 600) {
          keyRef.current('ok');
          Vibration.vibrate(10);
        }
        return;
      }
      if (Math.max(ax, ay) >= 28) keyRef.current(ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    },
  }), []);
  const [text, setText] = useState('');
  const sent = useRef('');
  const onText = (v: string) => {
    setText(v);
    let i = 0;
    const prev = sent.current;
    while (i < prev.length && i < v.length && prev[i] === v[i]) i++;
    for (let n = 0; n < Math.min(prev.length - i, 50); n++) onKey('backspace');
    if (v.slice(i)) onKey('text', v.slice(i));
    sent.current = v;
  };
  return (
    <ScrollView contentContainerStyle={{ padding: t.space.gutter, gap: t.space.md }} keyboardShouldPersistTaps="handled">
      <View {...pan.panHandlers} accessibilityLabel="Touch-pad: swipe to move, tap to select"
        style={{ height: 300, borderRadius: 28, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 14, opacity: paired ? 1 : 0.55 }}>
        <T variant="small" tone="muted">{paired ? 'Swipe to move · tap to select' : 'Pair this TV by QR code to use the touch-pad'}</T>
      </View>
      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        <PadButton icon="arrow-back" label="Back" onPress={() => onKey('back')} />
        <PadButton icon="home-outline" label="Home" onPress={() => onKey('home')} />
        <PadButton icon="information-circle-outline" label="Info" onPress={() => onKey('info')} />
      </View>
      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        <PadButton icon="play-back-outline" label="−10 s" onPress={() => (playing ? onSeek(-10_000) : onKey('rewind'))} />
        <PadButton icon={playing ? 'pause' : 'play'} label="Play / pause" big onPress={onToggle} />
        <PadButton icon="play-forward-outline" label="+10 s" onPress={() => (playing ? onSeek(10_000) : onKey('forward'))} />
      </View>
      <View style={{ flexDirection: 'row', gap: t.space.sm, alignItems: 'center' }}>
        <PadButton icon="volume-low-outline" label="Volume −" onPress={() => onVolume(-10)} />
        <T weight="700" center style={{ flex: 1 }}>{volume == null ? '—' : `${volume}%`}</T>
        <PadButton icon="volume-high-outline" label="Volume +" onPress={() => onVolume(10)} />
      </View>
      <Input
        icon="keypad-outline"
        value={text}
        editable={paired}
        onChangeText={onText}
        placeholder="Type on the TV (search, sign-in…)"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={() => { onKey('submit'); setText(''); sent.current = ''; }}
      />
    </ScrollView>
  );
}

function SecondScreen({ target, pos, cmd }: { target: Target; pos: number; cmd: (a: RemoteAction, o?: { itemId?: string; positionMs?: number; trackIndex?: number | null }) => void }) {
  const t = useTheme();
  const api = useApi();
  const st = target.state;
  const [info, setInfo] = useState<SecondScreenInfo | null>(null);
  const [song, setSong] = useState<SongIdResponse | null>(null);
  const [songBusy, setSongBusy] = useState(false);
  const [songErr, setSongErr] = useState<string | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!st?.itemId) return;
    let alive = true;
    api.get<SecondScreenInfo>(`/pair/targets/${encodeURIComponent(target.id)}/now`).then((r) => alive && setInfo(r), () => undefined);
    return () => {
      alive = false;
    };
  }, [api, target.id, st?.itemId]);

  if (!st?.itemId) {
    return <View style={{ padding: t.space.xl, alignItems: 'center', gap: t.space.sm }}><Icon name="tv-outline" size={40} color={t.colors.textMuted} /><T variant="heading">Nothing playing</T><T tone="muted" center>Start something from Browse or with the touch-pad.</T></View>;
  }
  const identify = async () => {
    setSongBusy(true);
    setSongErr(null);
    setSong(null);
    try {
      setSong(await api.post<SongIdResponse>(`/pair/targets/${encodeURIComponent(target.id)}/identify-song`));
    } catch (e) {
      setSongErr(e instanceof Error ? e.message : 'Could not identify the song');
    } finally {
      setSongBusy(false);
    }
  };
  const dur = st.durationMs ?? info?.item.durationMs ?? 0;
  const card = { backgroundColor: t.colors.surface, borderRadius: t.radius + 4, padding: t.space.md, gap: t.space.sm } as const;
  const people = (info?.item.people?.length ? info.item.people : info?.show?.people ?? []).slice(0, 16);
  return (
    <ScrollView contentContainerStyle={{ padding: t.space.gutter, gap: t.space.md }}>
      <View style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'flex-end' }}>
        <Img path={st.posterUrl} width={90} style={{ width: 90, height: 135, borderRadius: 8 }} />
        <View style={{ flex: 1 }}>
          <T variant="title">{st.title}</T>
          {st.subtitle ? <T tone="muted">{st.subtitle}</T> : null}
        </View>
      </View>
      {dur > 0 ? <Scrubber positionMs={pos} durationMs={dur} onSeek={(ms) => cmd('seek', { positionMs: ms })} trickplay={info?.trickplay ?? null} chapters={info?.item.chapters ?? null} markers={info?.item.markers} /> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: t.space.xl }}>
        <Button icon="play-back" variant="ghost" accessibilityLabel="Back 10 seconds" onPress={() => cmd('seek', { positionMs: Math.max(0, pos - 10_000) })} />
        <Button icon={st.paused ? 'play' : 'pause'} size="lg" accessibilityLabel={st.paused ? 'Play' : 'Pause'} onPress={() => cmd('togglePause')} />
        <Button icon="play-forward" variant="ghost" accessibilityLabel="Forward 10 seconds" onPress={() => cmd('seek', { positionMs: pos + 10_000 })} />
        {st.nextItemId ? <Button icon="play-skip-forward" variant="ghost" accessibilityLabel="Next episode" onPress={() => cmd('next')} /> : null}
      </View>
      {st.skip ? <Button label={st.skip.label} icon="play-skip-forward-outline" variant="secondary" onPress={() => cmd('skipSegment')} style={{ alignSelf: 'center' }} /> : null}

      {(st.audioTracks?.length ?? 0) > 1 ? (
        <View style={card}>
          <T weight="700">Audio</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
            {st.audioTracks!.map((a) => <Chip key={a.index} label={a.label} on={a.index === st.audioIndex} onPress={() => cmd('setAudioTrack', { trackIndex: a.index })} />)}
          </View>
        </View>
      ) : null}
      {(st.subtitleTracks?.length ?? 0) > 0 ? (
        <View style={card}>
          <T weight="700">Subtitles</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
            <Chip label="Off" on={st.subtitleIndex == null} onPress={() => cmd('setSubtitleTrack', { trackIndex: null })} />
            {st.subtitleTracks!.map((s) => <Chip key={s.index} label={s.label} on={s.index === st.subtitleIndex} onPress={() => cmd('setSubtitleTrack', { trackIndex: s.index })} />)}
          </View>
        </View>
      ) : null}

      <View style={card}>
        <T weight="700">What’s this song?</T>
        {song?.match ? (
          <View style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'center' }}>
            <Img path={song.match.coverUrl} width={64} style={{ width: 64, height: 64, borderRadius: 6 }} />
            <View style={{ flex: 1 }}>
              <T weight="700">{song.match.title}</T>
              <T tone="muted">{song.match.artists.join(', ')}{song.match.album ? ` · ${song.match.album}` : ''}</T>
              {song.match.libraryTrack ? <Button label="In your library" size="sm" icon="musical-notes" onPress={() => router.push(`/item/${song.match!.libraryTrack!.albumId ?? song.match!.libraryTrack!.id}`)} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
            </View>
          </View>
        ) : (
          <Button label={songBusy ? 'Listening to the scene…' : 'Identify'} icon="sparkles-outline" loading={songBusy} onPress={identify} style={{ alignSelf: 'flex-start' }} />
        )}
        {song && !song.available ? <T tone="muted">{song.reason}</T> : null}
        {song?.available && !song.match ? <T tone="muted">No match here. The web app can also listen with the microphone.</T> : null}
        {songErr ? <T tone="danger">{songErr}</T> : null}
      </View>

      {(info?.item.chapters?.length ?? 0) > 0 ? (
        <View style={card}>
          <T weight="700">Chapters</T>
          {info!.item.chapters!.map((c, i) => (
            <Pressable key={i} onPress={() => cmd('seek', { positionMs: c.startMs })} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
              <T tone={pos >= c.startMs && pos < c.endMs ? 'primary' : 'default'}>{c.title || `Chapter ${i + 1}`}</T>
              <T tone="muted">{formatClock(c.startMs)}</T>
            </Pressable>
          ))}
        </View>
      ) : null}

      {people.length ? (
        <View style={card}>
          <T weight="700">Cast &amp; crew</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space.md }}>
            {people.map((p, i) => (
              <View key={`${p.name}-${i}`} style={{ width: 80, gap: 2 }}>
                <Img path={p.imageUrl} width={80} style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: t.colors.surfaceAlt }} />
                <T variant="small" weight="700" numberOfLines={2}>{p.name}</T>
                <T variant="caption" tone="muted" numberOfLines={1}>{p.role || p.kind}</T>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {(info?.episodes.length ?? 0) > 0 ? (
        <View style={card}>
          <T weight="700">{info!.show?.title ?? 'Episodes'}</T>
          {info!.episodes.map((e) => (
            <Pressable key={e.id} onPress={() => e.id !== st.itemId && cmd('playItem', { itemId: e.id })} style={{ flexDirection: 'row', gap: t.space.sm, paddingVertical: 6 }}>
              <T tone="muted" style={{ width: 24, textAlign: 'right' }}>{e.index ?? ''}</T>
              <T style={{ flex: 1 }} tone={e.id === st.itemId ? 'primary' : 'default'} numberOfLines={1}>{e.title}</T>
            </Pressable>
          ))}
        </View>
      ) : null}
      {info?.next && info.next.id !== st.itemId ? (
        <Pressable onPress={() => cmd('playItem', { itemId: info.next!.id })} style={[card, { flexDirection: 'row', alignItems: 'center' }]}>
          <Img path={info.next.thumbUrl ?? info.next.posterUrl} width={120} style={{ width: 120, height: 68, borderRadius: 6 }} />
          <View style={{ flex: 1 }}>
            <T variant="caption" tone="muted">UP NEXT</T>
            <T weight="700" numberOfLines={2}>{info.next.title}</T>
          </View>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityState={{ selected: on }}
      style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: on ? t.colors.primary : t.colors.surfaceAlt }}>
      <T variant="small" weight="700" color={on ? t.colors.primaryText : t.colors.text}>{label}</T>
    </Pressable>
  );
}

function Browse({ target, onPlay }: { target: Target; onPlay: (it: Item) => void }) {
  const t = useTheme();
  const api = useApi();
  const [q, setQ] = useState('');
  const [stack, setStack] = useState<Item[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const parent = stack[stack.length - 1];
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      api.get<{ items: Item[] }>(`/pair/targets/${encodeURIComponent(target.id)}/browse`, parent ? { parentId: parent.id } : { q })
        .then((r) => alive && setItems(r.items), () => undefined);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, target.id, q, parent]);
  return (
    <ScrollView contentContainerStyle={{ padding: t.space.gutter, gap: t.space.sm }} keyboardShouldPersistTaps="handled">
      {parent ? (
        <Button label={parent.title} icon="chevron-back" variant="ghost" size="sm" onPress={() => setStack((s) => s.slice(0, -1))} style={{ alignSelf: 'flex-start' }} />
      ) : (
        <Input icon="search" value={q} onChangeText={setQ} placeholder={`Search ${target.crossUser ? `${target.ownerName}’s` : 'your'} library`} autoCorrect={false} returnKeyType="search" />
      )}
      {items.map((it) => (
        <Pressable key={it.id} onPress={() => (it.type === 'show' || it.type === 'season' ? setStack((s) => [...s, it]) : onPlay(it))}
          style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'center', paddingVertical: 4 }}>
          <Img path={it.posterUrl ?? it.thumbUrl} width={46} style={{ width: 46, height: 69, borderRadius: 4, backgroundColor: t.colors.surfaceAlt }} />
          <View style={{ flex: 1 }}>
            <T weight="700" numberOfLines={2}>{it.type === 'episode' && it.index != null ? `${it.index}. ` : ''}{it.title}</T>
            <T variant="small" tone="muted">{[it.year, it.type === 'show' ? 'Series' : it.type === 'season' ? 'Season' : null].filter(Boolean).join(' · ')}</T>
          </View>
          <Icon name={it.type === 'show' || it.type === 'season' ? 'chevron-forward' : 'play'} size={18} color={t.colors.textMuted} />
        </Pressable>
      ))}
    </ScrollView>
  );
}
