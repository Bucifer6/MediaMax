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
  audiobooks: 'book',
  podcasts: 'mic',
};

/** Spoken-word audio: plays in the audio player but keeps resume positions and offers speed. */
export const isSpokenAudio = (type: ItemType) => type === 'bookpart' || type === 'podcastepisode';
/** Anything the audio player (music state) handles. */
export const isAudioItem = (type: ItemType) => type === 'track' || isSpokenAudio(type);

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
    case 'audiobooks':
      return [{ key: 'audiobook', label: 'Audiobooks', type: 'audiobook' }];
    case 'podcasts':
      return [{ key: 'podcast', label: 'Podcasts', type: 'podcast' }];
    case 'videos':
    default:
      return [{ key: 'video', label: 'Videos', type: 'video' }];
  }
}
