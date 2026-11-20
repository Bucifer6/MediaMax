import { router } from 'expo-router';
import type { Channel, Item } from '@/api/types';

export function itemHref(item: Pick<Item, 'id' | 'type'>): string {
  if (item.type === 'photo') return `/photo/${item.id}`;
  return `/item/${item.id}`;
}

export function openItem(item: Pick<Item, 'id' | 'type'>) {
  router.push(itemHref(item) as never);
}

export function playItem(id: string, opts: { startMs?: number; restart?: boolean; mediaId?: string } = {}) {
  const q = new URLSearchParams();
  if (opts.mediaId) q.set('media', opts.mediaId);
  if (opts.startMs) q.set('start', String(Math.round(opts.startMs)));
  if (opts.restart) q.set('start', '0');
  const qs = q.toString();
  router.push(`/player/${id}${qs ? `?${qs}` : ''}` as never);
}

export function playChannel(ch: Pick<Channel, 'id'>, opts: { catchupStart?: string; durationMin?: number; categoryId?: string | null } = {}) {
  const q = new URLSearchParams();
  if (opts.catchupStart) q.set('catchupStart', opts.catchupStart);
  if (opts.durationMin) q.set('duration', String(opts.durationMin));
  if (opts.categoryId) q.set('category', opts.categoryId);
  const qs = q.toString();
  router.push(`/live/${ch.id}${qs ? `?${qs}` : ''}` as never);
}
