/**
 * HDHomeRun guide data: free for HDHomeRun owners. The tuner's discover.json carries a DeviceAuth token,
 * which the SiliconDust guide API accepts: https://api.hdhomerun.com/api/guide.php?DeviceAuth=…
 * Each call returns a few hours per channel; `Start=<unix time>` pages forward.
 */
import { USER_AGENT } from '../../../util/userAgent.js';
export const HDHR_DEFAULT_GUIDE = 'https://api.hdhomerun.com/api/guide.php';
export const hdhrGuideUrl = () => process.env.MEDIAMAX_HDHR_GUIDE_URL || HDHR_DEFAULT_GUIDE;

export interface HdhrGuideProgramme {
  StartTime: number;
  EndTime: number;
  Title: string;
  EpisodeNumber?: string;
  EpisodeTitle?: string;
  Synopsis?: string;
  OriginalAirdate?: number;
  ImageURL?: string;
  Filter?: string[];
  First?: number;
  SeriesID?: string;
}

export interface HdhrGuideChannel {
  GuideNumber: string;
  GuideName: string;
  Affiliate?: string;
  ImageURL?: string;
  Guide?: HdhrGuideProgramme[];
}

export function deviceBase(url: string): string {
  const base = url.trim().replace(/\/+$/, '').replace(/\/(lineup|discover)\.json$/i, '');
  return /^https?:\/\//i.test(base) ? base : `http://${base}`;
}

export async function deviceAuth(url: string): Promise<{ deviceAuth: string; deviceId: string | null; name: string | null }> {
  const res = await fetch(`${deviceBase(url)}/discover.json`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HDHomeRun discover.json returned HTTP ${res.status}`);
  const j = (await res.json()) as { DeviceAuth?: string; DeviceID?: string; FriendlyName?: string };
  if (!j.DeviceAuth) throw new Error('The HDHomeRun did not report a DeviceAuth (firmware too old, or not an HDHomeRun?)');
  return { deviceAuth: j.DeviceAuth, deviceId: j.DeviceID ?? null, name: j.FriendlyName ?? null };
}

/** Fetch up to `hours` of guide, paging with Start=. Sequential, at most 48 calls. */
export async function fetchHdhrGuide(auth: string, hours = 24): Promise<HdhrGuideChannel[]> {
  const byNum = new Map<string, HdhrGuideChannel>();
  const until = Math.floor(Date.now() / 1000) + hours * 3600;
  let start: number | null = null;
  for (let i = 0; i < 48; i++) {
    const url = `${hdhrGuideUrl()}?DeviceAuth=${encodeURIComponent(auth)}${start ? `&Start=${start}` : ''}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HDHomeRun guide returned HTTP ${res.status}`);
    const page = (await res.json()) as HdhrGuideChannel[] | null;
    if (!Array.isArray(page) || !page.length) break;
    let maxEnd: number = start ?? 0;
    for (const ch of page) {
      const cur = byNum.get(ch.GuideNumber) ?? { ...ch, Guide: [] };
      const seen = new Set(cur.Guide!.map((p) => p.StartTime));
      for (const p of ch.Guide ?? []) {
        if (!seen.has(p.StartTime)) cur.Guide!.push(p);
        if (p.EndTime > maxEnd) maxEnd = p.EndTime;
      }
      byNum.set(ch.GuideNumber, cur);
    }
    if (maxEnd >= until || (start !== null && maxEnd <= start)) break;
    start = maxEnd;
  }
  return [...byNum.values()];
}
