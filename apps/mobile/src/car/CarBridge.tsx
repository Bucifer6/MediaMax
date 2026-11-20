/**
 * Connects the car (CarPlay / Android Auto, via modules/mediamax-car) to the phone app.
 *
 * Mounted once, inside MusicProvider, in app/_layout.tsx. It
 *  - answers the car's browse and search requests from `CarTree` (REST API, current session),
 *  - plays what is picked in the car through the existing queue (`useMusic().playQueue`), so the
 *    phone's mini player, lock screen, Chromecast hand-off and progress reporting stay in charge,
 *  - applies transport commands from the car (play/pause, skip, ±15/30 s, speed),
 *  - mirrors the player state to the car (`updateNowPlaying`; Android Auto shows it as its Now
 *    Playing screen, CarPlay uses it for the Up Next and speed buttons).
 *
 * Renders nothing, and is not mounted at all where the native module does not exist (Expo Go, web,
 * TV builds, builds made without the config plugin).
 */
import { useEffect, useMemo, useRef } from 'react';
import { SPEEDS, useMusic } from '@/state/music';
import { useCapabilities, useSession } from '@/state/session';
import { MediaMaxCar, type CarCommand, type CarNowPlaying, type MediaMaxCarNativeModule } from '../../modules/mediamax-car';
import { CarTree, type PlayRequest } from './tree';

export function CarBridge() {
  if (!MediaMaxCar) return null;
  return <CarBridgeInner car={MediaMaxCar} />;
}

const errorMessage = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong');

function CarBridgeInner({ car }: { car: MediaMaxCarNativeModule }) {
  const { api, status } = useSession();
  const caps = useCapabilities();
  const music = useMusic();
  const musicRef = useRef(music);
  musicRef.current = music;

  const tree = useMemo(
    () =>
      new CarTree({
        api,
        status,
        musicEnabled: caps.music,
        player: () => {
          const m = musicRef.current;
          return { currentId: m.current?.id ?? null, queue: m.queue, index: m.index };
        },
      }),
    [api, status, caps.music],
  );
  const treeRef = useRef(tree);
  treeRef.current = tree;

  // The native side waits for this before asking for the browse tree.
  useEffect(() => {
    car.setReady(true);
    return () => car.setReady(false);
  }, [car]);

  // Sign-in / sign-out, server switch or feature flags changed: reload the car's lists.
  const firstTree = useRef(true);
  useEffect(() => {
    if (firstTree.current) {
      firstTree.current = false;
      return;
    }
    car.invalidate(null);
  }, [tree, car]);

  // Requests from the car.
  useEffect(() => {
    const apply = (req: PlayRequest) => {
      const m = musicRef.current;
      if (req.kind === 'queue' && req.items.length) m.playQueue(req.items, req.index, req.shuffle ? { shuffle: true } : undefined);
      else if (req.kind === 'jump') m.jumpTo(req.index);
    };
    const play = (resolve: () => Promise<PlayRequest>) => {
      resolve().then(apply, (e: unknown) => console.warn('[car] could not start playback:', errorMessage(e)));
    };
    const command = (name: CarCommand, value: number | null | undefined) => {
      const m = musicRef.current;
      switch (name) {
        case 'play':
          if (!m.current) play(() => treeRef.current.resolveSearchPlay(''));
          else if (!m.playing) m.toggle();
          break;
        case 'pause':
        case 'stop':
          m.pause();
          break;
        case 'toggle':
          m.toggle();
          break;
        case 'next':
          m.next();
          break;
        case 'previous':
          m.previous();
          break;
        case 'seekTo':
          if (typeof value === 'number') m.seek(value);
          break;
        case 'seekBy':
          if (typeof value === 'number') m.skip(value);
          break;
        case 'rate':
          if (m.spoken) m.setRate(SPEEDS.find((s) => s > m.rate + 0.001) ?? SPEEDS[0]);
          break;
      }
    };

    const subs = [
      car.addListener('onGetChildren', ({ requestId, parentId }) => {
        treeRef.current.children(parentId).then(
          (nodes) => car.resolveChildren(requestId, nodes, null),
          (e: unknown) => car.resolveChildren(requestId, null, errorMessage(e)),
        );
      }),
      car.addListener('onSearch', ({ requestId, query }) => {
        treeRef.current.search(query).then(
          (nodes) => car.resolveChildren(requestId, nodes, null),
          (e: unknown) => car.resolveChildren(requestId, null, errorMessage(e)),
        );
      }),
      car.addListener('onPlay', ({ mediaId }) => play(() => treeRef.current.resolvePlay(mediaId))),
      car.addListener('onPlayFromSearch', ({ query }) => {
        const m = musicRef.current;
        // "Play MediaMax" with something already queued: just resume it.
        if (!query.trim() && m.current) {
          if (!m.playing) m.toggle();
          return;
        }
        play(() => treeRef.current.resolveSearchPlay(query));
      }),
      car.addListener('onCommand', ({ command: name, value }) => command(name, value)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [car]);

  // Mirror the player into the car. Positions are extrapolated natively while playing, so only
  // send on changes and when the position jumps (seek, buffering).
  const { current, playing, buffering, positionMs, durationMs, spoken, rate, queue, index, error } = music;
  const artworkUrl = current && api ? api.image(current.posterUrl ?? current.thumbUrl, 600) : null;
  const lastSent = useRef<{ at: number; positionMs: number; key: string } | null>(null);
  useEffect(() => {
    const key = JSON.stringify([current?.id ?? null, playing, buffering, Math.round(durationMs / 1000), spoken, rate, queue.length, index, error, artworkUrl]);
    const now = Date.now();
    const prev = lastSent.current;
    if (prev && prev.key === key) {
      const expected = prev.positionMs + (playing && !buffering ? (now - prev.at) * (spoken ? rate : 1) : 0);
      if (Math.abs(positionMs - expected) < 3000) return;
    }
    lastSent.current = { at: now, positionMs, key };
    const state: CarNowPlaying | null = current
      ? {
          id: current.id,
          title: current.title,
          subtitle: current.grandparentTitle ?? current.parentTitle ?? null,
          album: current.parentTitle ?? null,
          artworkUrl,
          durationMs,
          positionMs,
          playing,
          buffering,
          spoken,
          rate: spoken ? rate : 1,
          hasNext: index < queue.length - 1,
          hasPrevious: index > 0,
          queueLength: queue.length,
          error,
        }
      : null;
    try {
      car.updateNowPlaying(state);
    } catch {
      /* ignore */
    }
  }, [car, current, playing, buffering, positionMs, durationMs, spoken, rate, queue.length, index, error, artworkUrl]);

  return null;
}
