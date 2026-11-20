/**
 * Enigma2 receivers (Vu+, Dreambox, Zgemma, Octagon, GigaBlue…) through OpenWebif:
 *   /api/deviceinfo (/api/about), /api/getservices (bouquets), /api/getservices?sRef=<bouquet> (services),
 *   /api/epgmulti?bRef=&time=&endTime= (whole bouquet guide), /api/epgservice?sRef= (one service, fallback),
 *   picons at /picon/<sref with _>.png; streams on port 8001 (http://box:8001/<sRef>), transcoding on 8002.
 * OpenWebif authentication is HTTP Basic; "streamauth" puts the same Basic login on port 8001.
 */
import { TunerHttp, TunerHttpError, baseUrl, withUserInfo } from './http.js';
import { isoFromUnix, type GuideSink, type TunerCategory, type TunerChannel, type TunerDevice, type TunerOptions, type TunerSync } from './types.js';

export interface E2SourceLike {
  url: string;
  username?: string | null;
  password?: string | null;
  options: TunerOptions;
  userAgent?: string | null;
}

export interface E2Service { servicereference: string; servicename: string; pos?: number; picon?: string; program?: number }
interface E2Event { sref?: string; sname?: string; title?: string; shortdesc?: string; longdesc?: string; begin_timestamp?: number; duration_sec?: number; genre?: string; id?: number }

export const client = (s: E2SourceLike) => new TunerHttp({ username: s.username, password: s.password, authType: s.options.authType ?? 'auto' }, s.userAgent || 'MediaMax/1.0');
const api = (s: E2SourceLike, path: string, params: Record<string, string> = {}) => {
  const u = new URL(`${baseUrl(s.url)}${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

/** Markers (1:64:…) are bouquet section labels, not playable services. */
export const isMarker = (ref: string) => /^1:64:/.test(ref) || /^1:320:/.test(ref);
/** Sub-bouquets inside a bouquet (1:7:…). */
const isBouquetRef = (ref: string) => /^1:7:/.test(ref);

/** Picon file name: the first 10 fields of the service reference, ':' → '_'. */
export function piconName(sref: string): string {
  return sref.split(':').slice(0, 10).join('_').replace(/_+$/, '');
}

export function streamUrl(s: E2SourceLike, sref: string): string {
  const u = new URL(baseUrl(s.url));
  const port = s.options.useTranscoding ? s.options.transcodePort || 8002 : s.options.streamPort || 8001;
  return `http://${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:${port}/${sref}`;
}

export async function device(s: E2SourceLike, http = client(s)): Promise<TunerDevice> {
  let info: { brand?: string; model?: string; mname?: string; boxtype?: string; enigmaver?: string; imagever?: string; webifver?: string; tuners?: { name?: string; type?: string }[] } | undefined;
  try {
    info = await http.json<typeof info>(api(s, '/api/deviceinfo'));
  } catch (e) {
    if ((e as TunerHttpError).status === 401) throw e;
    const about = await http.json<{ info?: typeof info }>(api(s, '/api/about'));
    info = about.info;
  }
  if (!info) throw new TunerHttpError('This does not look like an OpenWebif receiver (no /api/deviceinfo)');
  const tuners = (info.tuners ?? []).map((t) => [t.name, t.type].filter(Boolean).join(': '));
  return {
    name: [info.brand, info.model ?? info.mname ?? info.boxtype].filter(Boolean).join(' ') || 'Enigma2',
    model: info.model ?? info.boxtype ?? null, version: [info.imagever, info.webifver && `OpenWebif ${info.webifver}`].filter(Boolean).join(' · ') || null,
    tuners, tunerCount: tuners.length || null,
  };
}

export async function bouquets(s: E2SourceLike, http = client(s)): Promise<E2Service[]> {
  const r = await http.json<{ services?: E2Service[] }>(api(s, '/api/getservices'));
  return (r.services ?? []).filter((b) => b.servicereference && !isMarker(b.servicereference));
}

async function services(s: E2SourceLike, http: TunerHttp, bRef: string): Promise<E2Service[]> {
  const r = await http.json<{ services?: E2Service[] }>(api(s, '/api/getservices', { sRef: bRef }), 60000);
  return r.services ?? [];
}

export async function sync(s: E2SourceLike): Promise<TunerSync & { bouquets: { ref: string; name: string }[] }> {
  const http = client(s);
  const dev = await device(s, http);
  const all = await bouquets(s, http);
  if (!all.length) throw new TunerHttpError('The receiver reported no TV bouquets');
  const wanted = s.options.bouquets?.length ? all.filter((b) => s.options.bouquets!.includes(b.servicereference)) : all.slice(0, 1);
  const warnings: string[] = [];
  if (s.options.bouquets?.length && wanted.length < s.options.bouquets.length) warnings.push('Some selected bouquets no longer exist on the receiver');
  const categories: TunerCategory[] = [];
  const channels: TunerChannel[] = [];
  const seen = new Set<string>();
  const base = baseUrl(s.url);
  let n = 0;
  for (const b of wanted) {
    categories.push({ remoteId: b.servicereference, name: b.servicename });
    const list = await services(s, http, b.servicereference);
    for (const svc of list) {
      const ref = svc.servicereference;
      if (!ref || isMarker(ref) || isBouquetRef(ref)) continue;
      n++;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const picon = svc.picon ? (/^https?:/i.test(svc.picon) ? svc.picon : `${base}${svc.picon.startsWith('/') ? '' : '/'}${svc.picon}`) : `${base}/picon/${piconName(ref)}.png`;
      channels.push({
        remoteId: ref, name: svc.servicename?.trim() || ref, number: svc.pos ?? n, logo: withUserInfo(picon, s.username, s.password),
        category: b.servicereference, streamUrl: streamUrl(s, ref), epgId: ref,
      });
    }
  }
  return { device: dev, categories, channels, warnings, bouquets: all.map((b) => ({ ref: b.servicereference, name: b.servicename })) };
}

function toProgramme(e: E2Event, sref: string) {
  if (!e.title || !e.begin_timestamp || !e.duration_sec) return null;
  return {
    channel: sref, start: isoFromUnix(e.begin_timestamp), end: isoFromUnix(e.begin_timestamp + e.duration_sec), title: e.title,
    subtitle: e.shortdesc && e.shortdesc !== e.title ? e.shortdesc : null, description: e.longdesc || null, category: e.genre || null,
  };
}

/** EPG for the selected bouquets: epgmulti per bouquet, per-service epgservice when a box does not support it. */
export async function loadGuide(s: E2SourceLike, sink: GuideSink, channelRefs: { ref: string; name: string }[]) {
  const http = client(s);
  const all = await bouquets(s, http);
  const wanted = s.options.bouquets?.length ? all.filter((b) => s.options.bouquets!.includes(b.servicereference)) : all.slice(0, 1);
  for (const c of channelRefs) sink.channel({ id: c.ref, name: c.name, altNames: [], callsign: null, number: null, icon: null });
  sink.decide();
  const known = new Set(channelRefs.map((c) => c.ref));
  const now = Math.floor(Date.now() / 1000);
  const end = now + Math.max(1, Math.min(14, s.options.guideDays ?? 7)) * 86400;
  let count = 0;
  const covered = new Set<string>();
  for (const b of wanted) {
    try {
      const r = await http.json<{ events?: E2Event[] }>(api(s, '/api/epgmulti', { bRef: b.servicereference, time: String(now - 3600), endTime: String(end) }), 120000);
      for (const e of r.events ?? []) {
        if (!e.sref || !known.has(e.sref)) continue;
        const p = toProgramme(e, e.sref);
        if (p) {
          sink.programme(p);
          covered.add(e.sref);
          count++;
        }
      }
    } catch (e) {
      if ((e as TunerHttpError).status === 401) throw e;
    }
  }
  // Fallback: services the bouquet call did not cover (older OpenWebif without epgmulti).
  const missing = channelRefs.filter((c) => !covered.has(c.ref)).slice(0, 500);
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(missing.slice(i, i + 4).map(async (c) => {
      try {
        const r = await http.json<{ events?: E2Event[] }>(api(s, '/api/epgservice', { sRef: c.ref }), 30000);
        for (const e of r.events ?? []) {
          const p = toProgramme(e, c.ref);
          if (p) {
            sink.programme(p);
            count++;
          }
        }
      } catch {
        /* no EPG for this service */
      }
    }));
  }
  return count;
}
