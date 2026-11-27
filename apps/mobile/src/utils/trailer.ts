/**
 * Trailers. A local "Trailers" extra plays in our own player (works on every device, TVs included). Otherwise the
 * item's `trailerUrl` (TMDB, almost always YouTube) is handed to the system: on phones that opens the YouTube app or
 * the browser; Android TV / Fire TV have no browser, so we ask the YouTube app directly (`vnd.youtube:` first, then
 * the https link it also claims) and, when nothing can open it, say where to watch it instead of failing silently.
 */
import { Alert, Linking, Platform } from 'react-native';
import type { Item } from '@/api/types';
import { playItem } from './nav';
import { trailerUrlsFor } from './trailerLinks';

export { localTrailer, youtubeId } from './trailerLinks';

export async function openTrailer(opts: { trailerUrl?: string | null; local?: Pick<Item, 'id'> | null; tv?: boolean }): Promise<void> {
  if (opts.local) return playItem(opts.local.id, { restart: true });
  const url = opts.trailerUrl;
  if (!url) return;
  const tv = opts.tv ?? Platform.isTV;
  for (const u of trailerUrlsFor(url, tv)) {
    try {
      await Linking.openURL(u);
      return;
    } catch {
      /* try the next one */
    }
  }
  Alert.alert(
    'Trailer',
    tv ? `This TV has no app that can play it. Watch it on your phone or computer:\n\n${url}` : `Couldn't open the trailer:\n\n${url}`,
  );
}
