import type { Item, Program } from '@/api/types';

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function formatClock(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export function formatTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const today = new Date();
  const diff = Math.round((new Date(d.toDateString()).getTime() - new Date(today.toDateString()).getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function progressFraction(item: Pick<Item, 'durationMs' | 'userData'>): number {
  const d = item.durationMs ?? 0;
  if (!d || !item.userData?.positionMs) return 0;
  return Math.max(0, Math.min(1, item.userData.positionMs / d));
}

export function programProgress(p: Program | null | undefined, now = Date.now()): number {
  if (!p) return 0;
  const s = new Date(p.start).getTime();
  const e = new Date(p.end).getTime();
  if (e <= s) return 0;
  return Math.max(0, Math.min(1, (now - s) / (e - s)));
}

export function isAiring(p: Program, now = Date.now()) {
  return new Date(p.start).getTime() <= now && new Date(p.end).getTime() > now;
}

/** "S1 · E3" style label for episodes, "Disc 1 · 4" for tracks. */
export function episodeLabel(item: Item): string | null {
  if (item.type === 'episode' && item.index != null) {
    return `S${item.parentIndex ?? '?'} · E${item.index}`;
  }
  return null;
}

export function itemSubtitle(item: Item): string {
  switch (item.type) {
    case 'episode':
      return [item.grandparentTitle, episodeLabel(item)].filter(Boolean).join(' · ');
    case 'season':
      return item.parentTitle ?? '';
    case 'album':
      return [item.parentTitle, item.year].filter(Boolean).join(' · ');
    case 'track':
      return [item.grandparentTitle ?? item.parentTitle].filter(Boolean).join(' · ');
    case 'show':
      return [item.year, item.childCount ? `${item.childCount} season${item.childCount === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
    default:
      return item.year ? String(item.year) : '';
  }
}

export function languageName(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  const map: Record<string, string> = {
    en: 'English', eng: 'English', fr: 'French', fre: 'French', fra: 'French', de: 'German', ger: 'German', deu: 'German',
    es: 'Spanish', spa: 'Spanish', it: 'Italian', ita: 'Italian', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean',
    zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', pt: 'Portuguese', por: 'Portuguese', ru: 'Russian', rus: 'Russian',
    nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', sv: 'Swedish', swe: 'Swedish', da: 'Danish', dan: 'Danish', no: 'Norwegian', nor: 'Norwegian',
    fi: 'Finnish', fin: 'Finnish', pl: 'Polish', pol: 'Polish', ar: 'Arabic', ara: 'Arabic', hi: 'Hindi', hin: 'Hindi', tr: 'Turkish', tur: 'Turkish',
  };
  return map[code.toLowerCase()] ?? code.toUpperCase();
}
