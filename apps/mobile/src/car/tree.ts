/**
 * The browse tree shown in CarPlay and Android Auto, built from the MediaMax REST API.
 *
 *   root
 *   ├── tab:home       Continue listening (audiobooks, podcast episodes) · Recently played (music)
 *   ├── tab:music      Shuffle all · Playlists › tracks · Artists › albums › tracks
 *   ├── tab:books      In progress · All books (each plays and resumes the book)
 *   └── tab:podcasts   Shows › newest episodes
 *
 * Tabs only appear when the user can see a library of that kind (and, for music, when the server's
 * `features.music` flag is on). Lists are capped (driving-safe, and CarPlay may cut lists to 12 rows
 * anyway). Ids are opaque strings for the native side:
 *
 *   browsable  tab:*, music:playlists, music:artists, artist:<id>, album:<id>, playlist:<id>,
 *              podcast:<id>, queue
 *   playable   music:shuffle, book:<id> (resume), episode:<id>, q:<index> (jump in the queue),
 *              play:<context>:<index>:<itemId> (a track within a list held in `contexts`)
 */
import type { MediaMaxClient } from '@/api/client';
import type { Item, Library } from '@/api/types';
import type { SessionStatus } from '@/state/session';
import { formatDate, formatDuration, progressFraction } from '@/utils/format';
import { isAudioItem } from '@/utils/library';
import type { CarNode } from '../../modules/mediamax-car';
import { pickBestMatch, voiceQuery, type VoiceSearchHints } from './policy';

const ART = 300;

const LIMIT = {
  continue: 8,
  recent: 10,
  playlists: 50,
  artists: 200,
  albums: 50,
  tracks: 200,
  books: 100,
  booksInProgress: 5,
  podcasts: 50,
  episodes: 20,
  shuffle: 200,
  search: 30,
  queue: 50,
  contexts: 40,
} as const;

/** What the tree needs from the phone app. */
export interface CarTreeEnv {
  api: MediaMaxClient | null;
  status: SessionStatus;
  /** Server `features.music`. */
  musicEnabled: boolean;
  player: () => { currentId: string | null; queue: Item[]; index: number };
}

/** What to do when something is picked in the car. */
export type PlayRequest = { kind: 'queue'; items: Item[]; index: number; shuffle?: boolean } | { kind: 'jump'; index: number } | { kind: 'none' };

const message = (id: string, title: string, subtitle?: string): CarNode => ({ id: `msg:${id}`, title, subtitle: subtitle ?? null, browsable: false, playable: false });

function split(id: string): [string, string] {
  const i = id.indexOf(':');
  return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)];
}

export class CarTree {
  private contexts = new Map<string, Item[]>();
  private seq = 0;
  private libraries: Promise<Library[]> | null = null;

  constructor(private env: CarTreeEnv) {}

  // --------------------------------------------------------------- browse

  async children(parentId: string): Promise<CarNode[]> {
    if (parentId === 'root') return this.root();
    const api = this.requireApi();
    switch (parentId) {
      case 'tab:home':
        return this.home(api);
      case 'tab:music':
        return [
          { id: 'music:shuffle', title: 'Shuffle all', subtitle: 'Your whole music library', icon: 'shuffle', browsable: false, playable: true, mediaType: 'playlist' },
          { id: 'music:playlists', title: 'Playlists', browsable: true, playable: false, mediaType: 'folder' },
          { id: 'music:artists', title: 'Artists', browsable: true, playable: false, mediaType: 'folder' },
        ];
      case 'tab:books':
        return this.books(api);
      case 'tab:podcasts':
        return this.podcasts(api);
      case 'music:playlists': {
        const lists = await api.playlists();
        return lists.slice(0, LIMIT.playlists).map((p) => ({
          id: `playlist:${p.id}`,
          title: p.title,
          subtitle: p.childCount ? `${p.childCount} items` : null,
          artworkUrl: this.art(p),
          browsable: true,
          playable: false,
          mediaType: 'playlist',
        }));
      }
      case 'music:artists': {
        const res = await api.items({ type: 'artist', sort: 'title', order: 'asc', limit: LIMIT.artists });
        return res.items.map((a) => ({ id: `artist:${a.id}`, title: a.title, artworkUrl: this.art(a), browsable: true, playable: false, mediaType: 'artist' }));
      }
      case 'queue':
        return this.queue();
    }
    const [kind, id] = split(parentId);
    switch (kind) {
      case 'artist': {
        const res = await api.children(id, { sort: 'year', order: 'desc', limit: LIMIT.albums });
        const albums = res.items.filter((a) => a.type === 'album');
        if (!albums.length) {
          // Loose tracks without an album: list them directly.
          const tracks = await api.items({ ancestorId: id, type: 'track', sort: 'title', order: 'asc', limit: LIMIT.tracks });
          return this.trackNodes(tracks.items);
        }
        return albums.map((a) => ({ id: `album:${a.id}`, title: a.title, subtitle: a.year ? String(a.year) : null, artworkUrl: this.art(a), browsable: true, playable: false, mediaType: 'album' }));
      }
      case 'album': {
        const res = await api.children(id, { sort: 'index', order: 'asc', limit: LIMIT.tracks });
        return this.trackNodes(res.items.filter((t) => isAudioItem(t.type)));
      }
      case 'playlist': {
        const res = await api.children(id, { limit: LIMIT.tracks });
        return this.trackNodes(res.items.filter((t) => isAudioItem(t.type)));
      }
      case 'podcast': {
        const res = await api.children(id, { sort: 'releaseDate', order: 'desc', limit: LIMIT.episodes });
        return res.items.filter((e) => e.type === 'podcastepisode').map((e) => this.episodeNode(e));
      }
    }
    return [];
  }

  private async root(): Promise<CarNode[]> {
    const { status, api } = this.env;
    if (status === 'booting') throw new Error('Connecting…');
    if (status === 'offline') return [message('offline', "Can't reach your media server", 'Check your connection')];
    if (status !== 'signed-in' || !api) return [message('signin', 'Sign in to MediaMax', 'Choose a server and sign in to browse your library')];
    const has = await this.sections();
    const tabs: CarNode[] = [];
    if (has.music || has.books || has.podcasts) tabs.push({ id: 'tab:home', title: 'Home', icon: 'house.fill', browsable: true, playable: false, mediaType: 'folder' });
    if (has.music) tabs.push({ id: 'tab:music', title: 'Music', icon: 'music.note', browsable: true, playable: false, mediaType: 'folder' });
    if (has.books) tabs.push({ id: 'tab:books', title: 'Audiobooks', icon: 'book.fill', browsable: true, playable: false, mediaType: 'folder' });
    if (has.podcasts) tabs.push({ id: 'tab:podcasts', title: 'Podcasts', icon: 'mic.fill', browsable: true, playable: false, mediaType: 'folder' });
    if (!tabs.length) return [message('empty', 'Nothing to listen to', 'This server has no music, audiobook or podcast libraries')];
    return tabs;
  }

  private async sections() {
    if (!this.libraries) {
      const api = this.requireApi();
      this.libraries = api.libraries().catch((e: unknown) => {
        this.libraries = null;
        throw e;
      });
    }
    const libs = await this.libraries;
    return {
      music: this.env.musicEnabled && libs.some((l) => l.type === 'music'),
      books: libs.some((l) => l.type === 'audiobooks'),
      podcasts: libs.some((l) => l.type === 'podcasts'),
    };
  }

  private async home(api: MediaMaxClient): Promise<CarNode[]> {
    const has = await this.sections();
    const [spoken, recent] = await Promise.all([has.books || has.podcasts ? this.inProgress(api) : Promise.resolve([]), has.music ? this.recentTracks(api) : Promise.resolve([])]);
    const nodes: CarNode[] = [];
    for (const it of spoken.slice(0, LIMIT.continue)) {
      const node = it.type === 'bookpart' && it.parentId ? this.bookPartNode(it) : this.episodeNode(it);
      nodes.push({ ...node, group: 'Continue listening' });
    }
    if (recent.length) {
      const ctx = this.context(recent);
      recent.forEach((t, i) => nodes.push({ ...this.trackNode(ctx, recent, i), group: 'Recently played' }));
    }
    if (!nodes.length) nodes.push(message('home-empty', 'Nothing in progress', 'Pick something from the other tabs'));
    return nodes;
  }

  /** In-progress audiobook parts and podcast episodes (one row per book), most recent first. */
  private async inProgress(api: MediaMaxClient): Promise<Item[]> {
    const [home, items] = await Promise.all([
      api.home().catch(() => null),
      api.items({ type: 'bookpart,podcastepisode', sort: 'lastPlayed', order: 'desc', limit: 40 }).catch(() => null),
    ]);
    const fromHome = (home?.rows ?? []).filter((r) => r.type === 'continue').flatMap((r) => r.items);
    const all = [...fromHome, ...(items?.items ?? [])].filter((it) => (it.type === 'bookpart' || it.type === 'podcastepisode') && !it.userData.played && it.userData.positionMs > 0);
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const it of all) {
      const key = it.type === 'bookpart' && it.parentId ? `book:${it.parentId}` : it.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  }

  private async recentTracks(api: MediaMaxClient): Promise<Item[]> {
    const res = await api.items({ type: 'track', sort: 'lastPlayed', order: 'desc', limit: LIMIT.recent * 2 }).catch(() => null);
    return (res?.items ?? []).filter((t) => t.userData.lastPlayedAt).slice(0, LIMIT.recent);
  }

  private async books(api: MediaMaxClient): Promise<CarNode[]> {
    const [progress, all] = await Promise.all([this.inProgress(api), api.items({ type: 'audiobook', sort: 'title', order: 'asc', limit: LIMIT.books })]);
    const nodes: CarNode[] = progress
      .filter((p) => p.type === 'bookpart' && p.parentId)
      .slice(0, LIMIT.booksInProgress)
      .map((p) => ({ ...this.bookPartNode(p), group: 'In progress' }));
    for (const b of all.items) {
      nodes.push({ id: `book:${b.id}`, title: b.title, subtitle: b.parentTitle ?? null, artworkUrl: this.art(b), browsable: false, playable: true, group: 'All books', mediaType: 'audiobook' });
    }
    if (!nodes.length) nodes.push(message('books-empty', 'No audiobooks yet'));
    return nodes;
  }

  private async podcasts(api: MediaMaxClient): Promise<CarNode[]> {
    const subs = await api.podcasts();
    if (!subs.length) return [message('podcasts-empty', 'No podcast subscriptions', 'Subscribe to shows in MediaMax')];
    return subs.slice(0, LIMIT.podcasts).map((s) => ({
      id: `podcast:${s.itemId}`,
      title: s.title,
      subtitle: s.episodeCount ? `${s.episodeCount} episodes` : null,
      artworkUrl: s.imageUrl ? this.env.api?.image(s.imageUrl, ART) ?? null : null,
      browsable: true,
      playable: false,
      mediaType: 'podcast',
    }));
  }

  private queue(): CarNode[] {
    const { queue, index } = this.env.player();
    return queue.slice(index, index + LIMIT.queue).map((t, i) => ({
      id: `q:${index + i}`,
      title: t.title,
      subtitle: t.grandparentTitle ?? t.parentTitle ?? null,
      artworkUrl: this.art(t),
      browsable: false,
      playable: true,
      playing: i === 0,
      mediaType: t.type === 'track' ? 'track' : t.type === 'bookpart' ? 'chapter' : 'episode',
    }));
  }

  // --------------------------------------------------------------- search

  async search(query: string): Promise<CarNode[]> {
    const api = this.requireApi();
    const q = query.trim();
    if (!q) return [];
    const res = await api.search(q, LIMIT.search);
    const audio = res.items.filter((it) => SEARCH_ORDER.includes(it.type));
    const tracks = audio.filter((t) => t.type === 'track');
    const ctx = tracks.length ? this.context(tracks) : '';
    const nodes: CarNode[] = [];
    for (const it of audio) {
      switch (it.type) {
        case 'track':
          nodes.push({ ...this.trackNode(ctx, tracks, tracks.indexOf(it)), group: 'Songs' });
          break;
        case 'album':
          nodes.push({ id: `album:${it.id}`, title: it.title, subtitle: it.parentTitle ?? null, artworkUrl: this.art(it), browsable: true, playable: false, group: 'Albums', mediaType: 'album' });
          break;
        case 'artist':
          nodes.push({ id: `artist:${it.id}`, title: it.title, artworkUrl: this.art(it), browsable: true, playable: false, group: 'Artists', mediaType: 'artist' });
          break;
        case 'playlist':
          nodes.push({ id: `playlist:${it.id}`, title: it.title, artworkUrl: this.art(it), browsable: true, playable: false, group: 'Playlists', mediaType: 'playlist' });
          break;
        case 'audiobook':
          nodes.push({ id: `book:${it.id}`, title: it.title, subtitle: it.parentTitle ?? null, artworkUrl: this.art(it), browsable: false, playable: true, group: 'Audiobooks', mediaType: 'audiobook' });
          break;
        case 'bookpart':
          if (it.parentId) nodes.push({ ...this.bookPartNode(it), group: 'Audiobooks' });
          break;
        case 'podcast':
          nodes.push({ id: `podcast:${it.id}`, title: it.title, artworkUrl: this.art(it), browsable: true, playable: false, group: 'Podcasts', mediaType: 'podcast' });
          break;
        case 'podcastepisode':
          nodes.push({ ...this.episodeNode(it), group: 'Episodes' });
          break;
      }
    }
    // Group rows by kind (CarPlay / Android Auto show one header per run of the same group).
    return nodes.sort((a, b) => GROUP_ORDER.indexOf(a.group ?? '') - GROUP_ORDER.indexOf(b.group ?? ''));
  }

  // ----------------------------------------------------------------- play

  /** Resolves a playable node id to a queue. */
  async resolvePlay(mediaId: string): Promise<PlayRequest> {
    const [kind, rest] = split(mediaId);
    if (kind === 'q') return { kind: 'jump', index: Number(rest) || 0 };
    const api = this.requireApi();
    switch (kind) {
      case 'music': {
        if (rest !== 'shuffle') return { kind: 'none' };
        return this.shuffleAll(api);
      }
      case 'book':
        return this.resumeBook(api, rest);
      case 'episode':
        return { kind: 'queue', items: [await api.item(rest)], index: 0 };
      case 'play': {
        // play:<context>:<index>:<itemId>
        const [ctx, indexAndId] = split(rest);
        const [index, itemId] = split(indexAndId);
        const list = this.contexts.get(ctx);
        const i = Number(index);
        if (list && list[i]?.id === itemId) return { kind: 'queue', items: list, index: i };
        return { kind: 'queue', items: [await api.item(itemId)], index: 0 };
      }
    }
    return { kind: 'none' };
  }

  /**
   * Voice / "play from search" (Android Auto and Google Assistant, Siri "Play … in MediaMax"). An
   * empty query means "play something": the caller resumes the current queue; otherwise continue
   * listening, else shuffle the music. `hints` (media type, artist, album) come from the assistant's
   * structured request when it sends one and steer which search result is played.
   */
  async resolveSearchPlay(query: string, hints?: VoiceSearchHints | null): Promise<PlayRequest> {
    const api = this.requireApi();
    const q = voiceQuery(query, hints);
    if (!q) {
      const has = await this.sections();
      if (has.books || has.podcasts) {
        const [first] = await this.inProgress(api);
        if (first) return first.type === 'bookpart' && first.parentId ? this.resumeBook(api, first.parentId) : { kind: 'queue', items: [first], index: 0 };
      }
      return has.music ? this.shuffleAll(api) : { kind: 'none' };
    }
    const res = await api.search(q, LIMIT.search);
    const best = pickBestMatch(res.items, SEARCH_ORDER, hints);
    if (!best) return { kind: 'none' };
    switch (best.type) {
      case 'track': {
        const tracks = res.items.filter((t) => t.type === 'track');
        return { kind: 'queue', items: tracks, index: Math.max(0, tracks.indexOf(best)) };
      }
      case 'album':
      case 'playlist': {
        const kids = await api.children(best.id, best.type === 'album' ? { sort: 'index', order: 'asc', limit: LIMIT.tracks } : { limit: LIMIT.tracks });
        return { kind: 'queue', items: kids.items.filter((t) => isAudioItem(t.type)), index: 0 };
      }
      case 'artist': {
        const all = await api.items({ ancestorId: best.id, type: 'track', sort: 'index', limit: 500 });
        return { kind: 'queue', items: all.items, index: 0, shuffle: true };
      }
      case 'audiobook':
        return this.resumeBook(api, best.id);
      case 'bookpart':
        return best.parentId ? this.resumeBook(api, best.parentId) : { kind: 'queue', items: [best], index: 0 };
      case 'podcast': {
        const next = await api.next(best.id).catch(() => null);
        if (next) return { kind: 'queue', items: [next], index: 0 };
        const newest = await api.children(best.id, { sort: 'releaseDate', order: 'desc', limit: 1 });
        return newest.items[0] ? { kind: 'queue', items: [newest.items[0]], index: 0 } : { kind: 'none' };
      }
      case 'podcastepisode':
        return { kind: 'queue', items: [best], index: 0 };
    }
    return { kind: 'none' };
  }

  private async shuffleAll(api: MediaMaxClient): Promise<PlayRequest> {
    const res = await api.items({ type: 'track', sort: 'random', limit: LIMIT.shuffle });
    return { kind: 'queue', items: res.items, index: 0, shuffle: true };
  }

  /** Same as the book page: GET /items/:id/next picks the part, the player resumes its position. */
  private async resumeBook(api: MediaMaxClient, bookId: string): Promise<PlayRequest> {
    const [next, parts] = await Promise.all([api.next(bookId).catch(() => null), api.children(bookId, { sort: 'index', order: 'asc', limit: 1000 })]);
    const audio = parts.items.filter((p) => isAudioItem(p.type));
    const i = next ? audio.findIndex((p) => p.id === next.id) : -1;
    if (i >= 0) return { kind: 'queue', items: audio, index: i };
    if (next) return { kind: 'queue', items: [next], index: 0 };
    return audio.length ? { kind: 'queue', items: audio, index: 0 } : { kind: 'none' };
  }

  // ---------------------------------------------------------------- nodes

  private trackNodes(tracks: Item[]): CarNode[] {
    if (!tracks.length) return [message('no-tracks', 'Nothing to play here')];
    const ctx = this.context(tracks);
    return tracks.map((_, i) => this.trackNode(ctx, tracks, i));
  }

  private trackNode(ctx: string, list: Item[], i: number): CarNode {
    const t = list[i];
    return {
      id: `play:${ctx}:${i}:${t.id}`,
      title: t.title,
      subtitle: t.grandparentTitle ?? t.parentTitle ?? null,
      artworkUrl: this.art(t),
      browsable: false,
      playable: true,
      playing: t.id === this.env.player().currentId,
      mediaType: t.type === 'track' ? 'track' : t.type === 'bookpart' ? 'chapter' : 'episode',
    };
  }

  /** An audiobook part in progress, shown as its book (playing resumes the book). */
  private bookPartNode(part: Item): CarNode {
    return {
      id: `book:${part.parentId}`,
      title: part.parentTitle ?? part.title,
      subtitle: [part.grandparentTitle, part.parentTitle ? part.title : null].filter(Boolean).join(' · ') || null,
      artworkUrl: this.art(part),
      browsable: false,
      playable: true,
      progress: progressFraction(part) || null,
      playing: part.id === this.env.player().currentId,
      mediaType: 'audiobook',
    };
  }

  private episodeNode(ep: Item): CarNode {
    return {
      id: `episode:${ep.id}`,
      title: ep.title,
      subtitle: [ep.parentTitle, formatDate(ep.releaseDate), formatDuration(ep.durationMs)].filter(Boolean).join(' · ') || null,
      artworkUrl: this.art(ep),
      browsable: false,
      playable: true,
      progress: ep.userData.played ? 1 : progressFraction(ep) || null,
      playing: ep.id === this.env.player().currentId,
      mediaType: 'episode',
    };
  }

  private art(it: Item): string | null {
    return this.env.api?.image(it.posterUrl ?? it.thumbUrl, ART) ?? null;
  }

  private context(items: Item[]): string {
    const key = `c${++this.seq}`;
    this.contexts.set(key, items);
    while (this.contexts.size > LIMIT.contexts) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) break;
      this.contexts.delete(oldest);
    }
    return key;
  }

  private requireApi(): MediaMaxClient {
    const { api, status } = this.env;
    if (!api || status !== 'signed-in') throw new Error(status === 'offline' ? "Can't reach your media server" : 'Sign in to MediaMax to browse');
    return api;
  }
}

/** Item types the car can play or browse. Voice requests play the server's best-ranked match among them. */
const SEARCH_ORDER: Item['type'][] = ['track', 'album', 'artist', 'playlist', 'audiobook', 'bookpart', 'podcast', 'podcastepisode'];
const GROUP_ORDER = ['Songs', 'Albums', 'Artists', 'Playlists', 'Audiobooks', 'Podcasts', 'Episodes', ''];
