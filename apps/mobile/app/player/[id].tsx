import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { VideoPlayerScreen, type IntroChain } from '@/player/VideoPlayerScreen';
import { ExternalPlayerScreen } from '@/player/ExternalPlayerScreen';
import { externalPlayerSupported, getExternalPlayer } from '@/player/deviceSettings';
import { EXTERNAL_DEFAULT, type ExternalPlayerSetting } from '@/player/external';
import { Loading } from '@/components/States';
import { useDownloads } from '@/state/downloads';
import { useApi, useSession } from '@/state/session';

type Params = { id: string; start?: string; then?: string; intros?: string; nointro?: string; media?: string; thenMedia?: string; marathon?: string };

/**
 * Video player route. Cinema mode: a movie started from the beginning first plays the server's intros
 * (trailers, then a pre-roll), chained as /player/<intro>?then=<movie>&intros=<rest>.
 *
 * With Settings › Playback › External player on (Android), videos open in VLC / Kodi / … instead (no cinema intros;
 * downloads still play here).
 */
export default function PlayerRoute() {
  const { id, start, then, intros, nointro, media, thenMedia, marathon } = useLocalSearchParams<Params>();
  const api = useApi();
  const { user } = useSession();
  const downloaded = useDownloads().get(id)?.state === 'done';
  const [ext, setExt] = useState<ExternalPlayerSetting | null>(externalPlayerSupported ? null : EXTERNAL_DEFAULT);
  const [playHere, setPlayHere] = useState(false);
  useEffect(() => {
    if (!ext) void getExternalPlayer().then(setExt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const external = !!ext?.enabled && !then && !downloaded && !playHere;
  const wantsIntros = !!ext && !external && !playHere && !then && !nointro && start == null && user?.preferences.cinemaMode !== false;
  const [checked, setChecked] = useState(() => !!ext && !wantsIntros);

  useEffect(() => {
    if (!ext) return;
    if (!wantsIntros) {
      setChecked(true);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const item = await api.item(id);
        const fresh = item.type === 'movie' && !(item.userData.positionMs > 0 && !item.userData.played);
        const list = fresh ? await api.intros(id) : [];
        if (!alive) return;
        if (list.length) {
          const [first, ...rest] = list.map((x) => x.id);
          router.replace({ pathname: '/player/[id]', params: { id: first, then: id, ...(media ? { thenMedia: media } : {}), ...(rest.length ? { intros: rest.join(',') } : {}) } } as never);
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
  }, [id, wantsIntros, api, ext]);

  if (ext && external) {
    return <ExternalPlayerScreen key={id} itemId={id} startMs={start ? Number(start) : undefined} mediaId={media} packageName={ext.packageName} onPlayHere={() => setPlayHere(true)} />;
  }
  if (!checked) {
    return <Loading style={{ flex: 1, backgroundColor: '#000' }} />;
  }

  let chain: IntroChain | undefined;
  if (then) {
    const toMovie = () => router.replace({ pathname: '/player/[id]', params: { id: then, start: '0', nointro: '1', ...(thenMedia ? { media: thenMedia } : {}) } } as never);
    chain = {
      skip: toMovie,
      next: () => {
        const [n, ...rest] = (intros ?? '').split(',').filter(Boolean);
        if (!n) return toMovie();
        router.replace({ pathname: '/player/[id]', params: { id: n, then, ...(thenMedia ? { thenMedia } : {}), ...(rest.length ? { intros: rest.join(',') } : {}) } } as never);
      },
    };
  }
  return <VideoPlayerScreen key={id} target={{ kind: 'vod', itemId: id, startMs: start ? Number(start) : then ? 0 : undefined, mediaId: then ? undefined : media }} intro={chain} marathonId={marathon ?? null} />;
}
