import type { Item, ItemType, LibraryType } from '@mediamax/shared';
import type { IconName } from '../components/Icon';

export const PLAYABLE_VIDEO: ItemType[] = ['movie', 'episode', 'video'];

export function isVideo(item: Pick<Item, 'type'>) {
  return PLAYABLE_VIDEO.includes(item.type);
}
export function isAudio(item: Pick<Item, 'type'>) {
  return item.type === 'track' || item.type === 'bookpart' || item.type === 'podcastepisode';
}
/** Spoken-word audio remembers where you stopped (music tracks don't). */
export function hasAudioResume(item: Pick<Item, 'type'>) {
  return item.type === 'bookpart' || item.type === 'podcastepisode';
}

export function itemLink(item: Pick<Item, 'id' | 'type'>): string {
  return `/item/${encodeURIComponent(item.id)}`;
}

export function playLink(item: Pick<Item, 'id'>, opts: { fromStart?: boolean } = {}): string {
  return `/play/${encodeURIComponent(item.id)}${opts.fromStart ? '?start=0' : ''}`;
}

export function progressPct(item: Item): number {
  const d = item.durationMs ?? 0;
  if (!d || !item.userData?.positionMs) return 0;
  return Math.min(100, (item.userData.positionMs / d) * 100);
}

export function isResumable(item: Item): boolean {
  const p = progressPct(item);
  return p > 1 && p < 95 && !item.userData.played;
}

export function episodeCode(item: Item): string {
  if (item.type !== 'episode') return '';
  const s = item.parentIndex != null ? `S${item.parentIndex}` : '';
  const e = item.index != null ? `E${item.index}` : '';
  return [s, e].filter(Boolean).join(' · ');
}

/** Secondary line under a card title. */
export function itemSubtitle(item: Item): string {
  switch (item.type) {
    case 'episode':
      return [item.grandparentTitle, episodeCode(item)].filter(Boolean).join(' — ');
    case 'season':
      return item.parentTitle ?? '';
    case 'album':
      return [item.parentTitle, item.year].filter(Boolean).join(' · ');
    case 'track':
      return [item.grandparentTitle ?? item.parentTitle].filter(Boolean).join('');
    case 'audiobook':
      return item.parentTitle ?? (item.year ? String(item.year) : '');
    case 'bookpart':
      return item.parentTitle ?? '';
    case 'podcast':
      return item.childCount ? `${item.childCount} episode${item.childCount === 1 ? '' : 's'}` : '';
    case 'podcastepisode':
      return [item.parentTitle, item.releaseDate ? new Date(item.releaseDate).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''].filter(Boolean).join(' · ');
    case 'show':
      return [item.year, item.childCount ? `${item.childCount} season${item.childCount > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
    default:
      return item.year ? String(item.year) : '';
  }
}

/** Card title — episodes show their own title, others their title. */
export function cardTitle(item: Item): string {
  return item.title;
}

export function posterFor(item: Item): string | null {
  return item.posterUrl ?? item.thumbUrl ?? item.backdropUrl ?? null;
}

export function landscapeFor(item: Item): string | null {
  return item.thumbUrl ?? item.backdropUrl ?? item.posterUrl ?? null;
}

export function isSquare(item: Pick<Item, 'type'>) {
  return ['album', 'artist', 'track', 'playlist', 'photo', 'audiobook', 'bookpart', 'podcast', 'podcastepisode'].includes(item.type);
}

export function libraryIcon(type: LibraryType): IconName {
  switch (type) {
    case 'movies':
    case 'iptv-movies':
      return 'film';
    case 'shows':
    case 'iptv-shows':
      return 'shows';
    case 'music':
      return 'music';
    case 'photos':
      return 'image';
    case 'audiobooks':
      return 'book';
    case 'podcasts':
      return 'podcast';
    default:
      return 'video';
  }
}

export function libraryItemTypes(type: LibraryType): string {
  switch (type) {
    case 'movies':
    case 'iptv-movies':
      return 'movie';
    case 'shows':
    case 'iptv-shows':
      return 'show';
    case 'music':
      return 'album';
    case 'photos':
      return 'photo';
    case 'videos':
      return 'video';
    case 'audiobooks':
      return 'audiobook';
    case 'podcasts':
      return 'podcast';
  }
}

export function isIptvLibrary(type: LibraryType) {
  return type === 'iptv-movies' || type === 'iptv-shows';
}

export const CONTENT_RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
