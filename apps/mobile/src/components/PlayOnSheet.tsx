/** "Play on…": pick another of your online devices and send it an item or channel (remote control). */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { RemoteTarget, Renderer, RendererState } from '@/api/types';
import { discoverRenderers, listRenderers, playOnRenderer, rendererCommand, RENDERER_ICON, RENDERER_KIND_LABEL } from '@/cast/renderers';
import { useApi } from '@/state/session';
import { useRemote } from '@/state/remote';
import { useTheme } from '@/theme';
import { formatClock } from '@/utils/format';
import { Button } from './Button';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { T } from './Text';

const ICONS = { ios: 'phone-portrait-outline', android: 'phone-portrait-outline', tvos: 'tv-outline', androidtv: 'tv-outline', roku: 'tv-outline', web: 'desktop-outline', other: 'hardware-chip-outline' } as const;

export interface PlayOnWhat {
  itemId?: string;
  channelId?: string;
  /** Start position (ms) for an item. */
  positionMs?: number;
  title?: string;
}

export function PlayOnSheet({ visible, what, onClose, onSent }: { visible: boolean; what: PlayOnWhat; onClose: () => void; /** E.g. pause the local player after handing playback over. */ onSent?: (target: RemoteTarget) => void }) {
  const t = useTheme();
  const remote = useRemote();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { refreshTargets } = remote;

  useEffect(() => {
    if (!visible) return;
    setSentTo(null);
    void refreshTargets();
  }, [visible, refreshTargets]);

  const pick = (target: RemoteTarget) => {
    if (what.channelId) remote.send(target.id, 'playChannel', { channelId: what.channelId });
    else if (what.itemId) remote.send(target.id, 'playItem', { itemId: what.itemId, positionMs: what.positionMs && what.positionMs > 0 ? Math.round(what.positionMs) : undefined });
    else return;
    setSentTo(target.deviceName);
    onSent?.(target);
    setTimeout(onClose, 900);
  };

  return (
    <Sheet visible={visible} title="Play on…" subtitle={what.title ? `Send “${what.title}” to another device` : 'Send to another of your devices'} onClose={onClose}>
      {!remote.enabled ? (
        <T tone="muted">Connecting to the server…</T>
      ) : sentTo ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingVertical: t.space.md }}>
          <Icon name="checkmark-circle" color={t.colors.success} />
          <T weight="700">Sent to {sentTo}</T>
        </View>
      ) : remote.targets.length ? (
        <View style={{ gap: t.space.xs }}>
          {remote.targets.map((target, i) => (
            <TargetRow key={target.id} target={target} first={i === 0} onPick={() => pick(target)} onToggle={() => remote.send(target.id, 'togglePause')} />
          ))}
        </View>
      ) : remote.loading ? (
        <ActivityIndicator color={t.colors.primary} />
      ) : (
        <View style={{ gap: t.space.sm, paddingVertical: t.space.sm }}>
          <T weight="700">No other devices online</T>
          <T tone="muted">Open Kinora on a TV, phone or browser signed in to your account and it will show up here.</T>
        </View>
      )}
      {what.itemId && !what.channelId ? <RendererSection visible={visible} what={what} /> : null}
      <View style={{ flexDirection: 'row', gap: t.space.sm, justifyContent: 'flex-end' }}>
        <Button label="Refresh" icon="refresh" variant="ghost" size="sm" onPress={() => void refreshTargets()} loading={remote.loading} hasTVPreferredFocus={!remote.targets.length} />
        <Button label="Close" variant="secondary" size="sm" onPress={onClose} />
      </View>
    </Sheet>
  );
}

function TargetRow({ target, first, onPick, onToggle }: { target: RemoteTarget; first: boolean; onPick: () => void; onToggle: () => void }) {
  const t = useTheme();
  const st = target.state;
  const playingLine = st && (st.title || st.itemId || st.channelId) ? `${st.paused ? 'Paused' : 'Playing'} · ${st.title ?? ''}${st.durationMs ? ` · ${formatClock(st.positionMs)} / ${formatClock(st.durationMs)}` : ''}` : 'Idle';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs }}>
      <Focusable
        onPress={onPick}
        hasTVPreferredFocus={first}
        focusScale={t.isTV ? 1.02 : 1}
        containerStyle={{ flex: 1 }}
        accessibilityLabel={`Play on ${target.deviceName}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.text, t.dark ? 0.06 : 0.04) }}
      >
        <Icon name={ICONS[target.platform] ?? 'hardware-chip-outline'} color={t.colors.primary} size={t.isTV ? t.s(28) : 24} />
        <View style={{ flex: 1 }}>
          <T weight="700" numberOfLines={1}>
            {target.deviceName}
          </T>
          <T variant="small" tone="muted" numberOfLines={1}>
            {playingLine}
          </T>
        </View>
        <Icon name="play-circle-outline" color={t.colors.textMuted} />
      </Focusable>
      {st && (st.itemId || st.channelId) ? (
        <Button icon={st.paused ? 'play' : 'pause'} variant="secondary" size="sm" onPress={onToggle} accessibilityLabel={st.paused ? `Resume on ${target.deviceName}` : `Pause on ${target.deviceName}`} />
      ) : null}
    </View>
  );
}

/** TVs, speakers and Kodi boxes on the network ("Play to"): the server streams to them directly. */
function RendererSection({ visible, what }: { visible: boolean; what: PlayOnWhat }) {
  const t = useTheme();
  const api = useApi();
  const [list, setList] = useState<Renderer[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ renderer: Renderer; state: RendererState } | null>(null);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setError(null);
    listRenderers(api).then((l) => alive && setList(l)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [visible, api]);

  const search = async () => {
    setSearching(true);
    try {
      setList(await discoverRenderers(api));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };
  const send = async (r: Renderer) => {
    if (!what.itemId) return;
    setBusy(r.id);
    setError(null);
    try {
      const state = await playOnRenderer(api, r.id, { itemId: what.itemId, startMs: what.positionMs && what.positionMs > 0 ? Math.round(what.positionMs) : undefined });
      setPlaying({ renderer: r, state });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const control = async (action: 'pause' | 'resume' | 'stop') => {
    if (!playing) return;
    try {
      const state = await rendererCommand(api, playing.renderer.id, action);
      setPlaying(action === 'stop' ? null : { ...playing, state });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!list.length && !searching) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.sm }}>
        <T variant="small" tone="muted" style={{ flex: 1 }}>No TVs or speakers found on your network.</T>
        <Button label="Search" icon="search" variant="ghost" size="sm" onPress={() => void search()} />
      </View>
    );
  }
  return (
    <View style={{ gap: t.space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T weight="700">TVs & speakers</T>
        <Button label="Search" icon="search" variant="ghost" size="sm" onPress={() => void search()} loading={searching} />
      </View>
      {playing ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.primary, 0.12) }}>
          <Icon name="radio-outline" color={t.colors.primary} />
          <T weight="700" numberOfLines={1} style={{ flex: 1 }}>
            Playing on {playing.renderer.name}
          </T>
          <Button icon={playing.state.state === 'paused' ? 'play' : 'pause'} variant="secondary" size="sm" onPress={() => void control(playing.state.state === 'paused' ? 'resume' : 'pause')} accessibilityLabel={playing.state.state === 'paused' ? 'Resume' : 'Pause'} />
          <Button icon="stop" variant="secondary" size="sm" onPress={() => void control('stop')} accessibilityLabel={`Stop on ${playing.renderer.name}`} />
        </View>
      ) : null}
      {list.map((r) => (
        <Focusable
          key={r.id}
          onPress={() => void send(r)}
          disabled={!!busy}
          accessibilityLabel={`Play on ${r.name}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.text, t.dark ? 0.06 : 0.04) }}
        >
          <Icon name={RENDERER_ICON[r.kind]} color={t.colors.primary} size={t.isTV ? t.s(28) : 24} />
          <View style={{ flex: 1 }}>
            <T weight="700" numberOfLines={1}>
              {r.name}
            </T>
            <T variant="small" tone="muted" numberOfLines={1}>
              {[RENDERER_KIND_LABEL[r.kind], r.model, r.nowPlaying ? `${r.nowPlaying.state} · ${r.nowPlaying.title}` : null].filter(Boolean).join(' · ')}
            </T>
          </View>
          {busy === r.id ? <ActivityIndicator color={t.colors.primary} /> : <Icon name="play-circle-outline" color={t.colors.textMuted} />}
        </Focusable>
      ))}
      {error ? (
        <T variant="small" style={{ color: t.colors.danger }}>
          {error}
        </T>
      ) : null}
    </View>
  );
}
