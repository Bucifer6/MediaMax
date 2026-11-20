import type { Item } from '@mediamax/shared';
import { api } from '../api/endpoints';

/** For a show/season, find the episode the user should watch next. */
export async function findNextEpisode(item: Item): Promise<Item | null> {
  if (item.type === 'season') {
    const eps = (await api.items.children(item.id, { sort: 'index', order: 'asc', limit: 500 })).items;
    return eps.find((e) => !e.userData.played) ?? eps[0] ?? null;
  }
  if (item.type === 'show') {
    try {
      const n = await api.items.next(item.id);
      if (n && n.type === 'episode') return n;
    } catch {
      /* fall through */
    }
    const seasons = (await api.items.children(item.id, { sort: 'index', order: 'asc', limit: 200 })).items;
    const ordered = [...seasons.filter((s) => (s.index ?? 0) > 0), ...seasons.filter((s) => (s.index ?? 0) === 0)];
    const target = ordered.find((s) => (s.userData.unplayedCount ?? 1) > 0 && !s.userData.played) ?? ordered[0];
    if (!target) return null;
    return findNextEpisode(target);
  }
  return null;
}

/** Expand a container into playable audio tracks. */
export async function tracksFor(item: Item): Promise<Item[]> {
  if (item.type === 'track') return [item];
  if (item.type === 'album' || item.type === 'playlist') {
    return (await api.items.children(item.id, { sort: item.type === 'album' ? 'index' : undefined, limit: 1000 })).items.filter((i) => i.type === 'track');
  }
  if (item.type === 'artist') {
    const albums = (await api.items.children(item.id, { sort: 'year', limit: 200 })).items;
    const lists = await Promise.all(albums.filter((a) => a.type === 'album').map((a) => tracksFor(a)));
    const direct = albums.filter((a) => a.type === 'track');
    return [...lists.flat(), ...direct];
  }
  return [];
}

export function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
