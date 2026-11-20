import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { VideoPlayerScreen, type IntroChain } from '@/player/VideoPlayerScreen';
import { Loading } from '@/components/States';
import { useApi, useSession } from '@/state/session';

type Params = { id: string; start?: string; then?: string; intros?: string; nointro?: string };

/**
 * Video player route. Cinema mode: a movie started from the beginning first plays the server's intros
 * (trailers, then a pre-roll), chained as /player/<intro>?then=<movie>&intros=<rest>.
 */
export default function PlayerRoute() {
  const { id, start, then, intros, nointro } = useLocalSearchParams<Params>();
  const api = useApi();
  const { user } = useSession();
  const wantsIntros = !then && !nointro && start == null && user?.preferences.cinemaMode !== false;
  const [checked, setChecked] = useState(!wantsIntros);

  useEffect(() => {
    if (!wantsIntros) return;
    let alive = true;
    (async () => {
      try {
        const item = await api.item(id);
        const fresh = item.type === 'movie' && !(item.userData.positionMs > 0 && !item.userData.played);
        const list = fresh ? await api.intros(id) : [];
        if (!alive) return;
        if (list.length) {
          const [first, ...rest] = list.map((x) => x.id);
          router.replace({ pathname: '/player/[id]', params: { id: first, then: id, ...(rest.length ? { intros: rest.join(',') } : {}) } } as never);
          return;
        }
      } catch {
        /* no intros — just play */
      }
      if (alive) setChecked(true);
    })();
    return () => {
      alive = false;
    };
  }, [id, wantsIntros, api]);

  if (!checked) {
    return <Loading style={{ flex: 1, backgroundColor: '#000' }} />;
  }

  let chain: IntroChain | undefined;
  if (then) {
    const toMovie = () => router.replace({ pathname: '/player/[id]', params: { id: then, start: '0', nointro: '1' } } as never);
    chain = {
      skip: toMovie,
      next: () => {
        const [n, ...rest] = (intros ?? '').split(',').filter(Boolean);
        if (!n) return toMovie();
        router.replace({ pathname: '/player/[id]', params: { id: n, then, ...(rest.length ? { intros: rest.join(',') } : {}) } } as never);
      },
    };
  }
  return <VideoPlayerScreen key={id} target={{ kind: 'vod', itemId: id, startMs: start ? Number(start) : then ? 0 : undefined }} intro={chain} />;
}
