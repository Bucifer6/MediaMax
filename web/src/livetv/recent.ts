/** Recently watched live channels (newest first), kept per user on this device for the Live TV home. */
const MAX = 12;
const key = (userId: string | undefined) => `vibe.livetv.recent.${userId ?? 'anon'}`;

export function recentChannelIds(userId: string | undefined): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(userId)) || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function rememberChannel(userId: string | undefined, channelId: string) {
  try {
    const list = [channelId, ...recentChannelIds(userId).filter((x) => x !== channelId)].slice(0, MAX);
    localStorage.setItem(key(userId), JSON.stringify(list));
  } catch {
    /* private mode */
  }
}
