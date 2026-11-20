import type { ItemType, Library, LibraryType } from '@/api/types';
import type { IconName } from '@/components/Icon';

export const LIBRARY_ICON: Record<LibraryType, IconName> = {
  movies: 'film',
  shows: 'tv',
  music: 'musical-notes',
  photos: 'images',
  videos: 'videocam',
  'iptv-movies': 'film-outline',
  'iptv-shows': 'tv-outline',
};

/** The item types a library grid shows (music libraries have tabs). */
export function browseTypes(lib: Library): { key: string; label: string; type: ItemType }[] {
  switch (lib.type) {
    case 'movies':
    case 'iptv-movies':
      return [{ key: 'movie', label: 'Movies', type: 'movie' }];
    case 'shows':
    case 'iptv-shows':
      return [{ key: 'show', label: 'Shows', type: 'show' }];
    case 'music':
      return [
        { key: 'album', label: 'Albums', type: 'album' },
        { key: 'artist', label: 'Artists', type: 'artist' },
        { key: 'track', label: 'Songs', type: 'track' },
      ];
    case 'photos':
      return [{ key: 'photo', label: 'Photos', type: 'photo' }];
    case 'videos':
    default:
      return [{ key: 'video', label: 'Videos', type: 'video' }];
  }
}
