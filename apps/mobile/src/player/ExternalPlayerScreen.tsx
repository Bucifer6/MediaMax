/**
 * "Open in external player" (Settings › Playback, Android / Android TV / Fire TV): asks the server for a direct-play
 * stream (externalPlayerProfile), hands its URL to VLC / Kodi / Just Player … (MediaMaxMedia.openExternalPlayer, an
 * ACTION_VIEW intent with title and resume position) and, when the player returns a position, reports it so resume
 * and watched state stay right. Players that return nothing (Kodi) leave the resume point as it was.
 */
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type { PlaybackInfo } from '@/api/types';
import { Button } from '@/components/Button';
import { Loading } from '@/components/States';
import { T } from '@/components/Text';
import { useApi, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { useBackHandler } from '@/tv';
import { MediaMaxMedia } from '../../modules/mediamax-media';
import { externalPlayerLabel, externalPlayerProfile, externalProgress, externalSeekMs, type ExternalResult } from './external';

/** Keeps the server session alive while the other app plays (the server reaps sessions idle for 5 min). */
const HEARTBEAT_MS = 60_000;

type Phase = { kind: 'starting' } | { kind: 'playing'; label: string } | { kind: 'failed'; message: string };

export function ExternalPlayerScreen({ itemId, startMs, mediaId, packageName, onPlayHere }: {
  itemId: string;
  startMs?: number;
  mediaId?: string;
  packageName: string | null;
  /** Fall back to the built-in player. */
  onPlayHere: () => void;
}) {
  const t = useTheme();
  const api = useApi();
  const { user } = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const infoRef = useRef<PlaybackInfo | null>(null);
  const doneRef = useRef(false);

  /** Report the final position (if any), end the server session and leave. */
  const finish = useCallback(
    async (result: ExternalResult | null, leave = true) => {
      if (doneRef.current) return;
      doneRef.current = true;
      const pi = infoRef.current;
      infoRef.current = null;
      if (pi) {
        const progress = result ? externalProgress(result, pi) : null;
        if (progress) await api.sessionProgress(pi.sessionId, { ...progress, state: 'stopped', sessionId: pi.sessionId }).catch(() => undefined);
        await api.stopSession(pi.sessionId).catch(() => undefined);
      }
      if (leave) router.back();
    },
    [api],
  );

  useEffect(() => {
    let alive = true;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    (async () => {
      const open = MediaMaxMedia?.openExternalPlayer;
      if (!open) return setPhase({ kind: 'failed', message: 'This version of the app can’t open other players yet.' });
      let pi: PlaybackInfo;
      try {
        pi = await api.playback(itemId, {
          mediaId,
          startMs: startMs != null ? Math.round(startMs) : undefined,
          subtitleStreamIndex: null,
          deviceProfile: externalPlayerProfile(user?.preferences.maxBitrate ?? null),
        });
      } catch (e) {
        if (alive) setPhase({ kind: 'failed', message: e instanceof Error ? e.message : 'Playback failed' });
        return;
      }
      if (!alive) {
        api.stopSession(pi.sessionId).catch(() => undefined);
        return;
      }
      infoRef.current = pi;
      const seekMs = externalSeekMs(pi);
      const mime = /^(video|application)\//.test(pi.mimeType ?? '') ? pi.mimeType : 'video/*';
      setPhase({ kind: 'playing', label: packageName ? externalPlayerLabel(packageName) : 'another app' });
      const ping = () => {
        const cur = infoRef.current;
        if (cur) api.sessionProgress(cur.sessionId, { positionMs: pi.startMs ?? 0, durationMs: pi.durationMs ?? undefined, state: 'playing', sessionId: cur.sessionId }).catch(() => undefined);
      };
      ping();
      heartbeat = setInterval(ping, HEARTBEAT_MS);
      let result: ExternalResult;
      try {
        result = await open({ url: api.withAuthQuery(pi.url), title: pi.subtitle ? `${pi.title} · ${pi.subtitle}` : pi.title, positionMs: seekMs, packageName, mimeType: mime });
      } catch (e) {
        result = { launched: false, reason: e instanceof Error ? e.message : undefined };
      }
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (!alive) return;
      if (!result.launched) {
        await finish(null, false);
        doneRef.current = false;
        setPhase({ kind: 'failed', message: 'No app on this device can open this video. Install VLC or Just Player, or play it here.' });
        return;
      }
      await finish(result);
    })();
    return () => {
      alive = false;
      if (heartbeat) clearInterval(heartbeat);
      // Left while the other app was still open (Back / Done here): end the session without a position.
      const pi = infoRef.current;
      if (pi && !doneRef.current) {
        doneRef.current = true;
        infoRef.current = null;
        api.stopSession(pi.sessionId).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  useBackHandler(() => {
    void finish(null);
    return true;
  });

  if (phase.kind === 'starting') return <Loading style={{ flex: 1, backgroundColor: '#000' }} label="Opening the player…" />;
  return (
    <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: t.space.xl, gap: t.space.lg }}>
      <T variant="title" style={{ color: '#fff', textAlign: 'center' }}>
        {phase.kind === 'playing' ? `Playing in ${phase.label}` : 'Couldn’t open the player'}
      </T>
      <T tone="muted" style={{ textAlign: 'center', maxWidth: t.isTV ? t.s(720) : undefined }}>
        {phase.kind === 'playing' ? 'Close the player to come back here. Your position is saved when the player reports it.' : phase.message}
      </T>
      <View style={{ flexDirection: 'row', gap: t.space.md }}>
        <Button label="Play here instead" icon="play" variant={phase.kind === 'failed' ? 'primary' : 'secondary'} hasTVPreferredFocus={phase.kind === 'failed'} onPress={() => void finish(null, false).then(onPlayHere)} />
        <Button label="Done" variant={phase.kind === 'playing' ? 'primary' : 'secondary'} hasTVPreferredFocus={phase.kind === 'playing'} onPress={() => void finish(null)} />
      </View>
    </View>
  );
}
