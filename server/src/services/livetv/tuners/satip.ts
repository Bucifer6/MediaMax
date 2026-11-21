/**
 * SAT>IP servers (DVB-S/S2/T/T2/C over RTSP): Digital Devices Octopus NET, Telestar, Inverto, minisatip,
 * and the AVM FRITZ!Box cable models (6490/6590/6591/6660 Cable…).
 *
 * Channel lists come from an M3U of SAT>IP URLs (rtsp://<ip>/?src=1&freq=…&pids=… or http://<ip>/?…) or, for a
 * FRITZ!Box, from its built-in lists at /dvb/m3u/tvhd.m3u, tvsd.m3u and radio.m3u. The tuner count comes from the
 * device description's <satip:X_SATIPCAP> ("DVBS2-2,DVBT-2" = two satellite and two terrestrial tuners).
 */
import { parseM3u } from '../m3u.js';
import { TunerHttp, TunerHttpError, baseUrl } from './http.js';
import type { TunerCategory, TunerChannel, TunerDevice, TunerOptions, TunerSync } from './types.js';

export interface SatipSourceLike {
  url: string;
  options: TunerOptions;
  userAgent?: string | null;
}

export const FRITZ_LISTS: Record<string, string> = { tvhd: 'TV (HD)', tvsd: 'TV (SD)', radio: 'Radio' };

/** "DVBS2-2,DVBT-2,DVBC-4" → { total: 8, parts: ["DVB-S2 ×2", …] }. */
export function parseSatipCap(cap: string | null | undefined): { total: number; parts: string[] } {
  const parts: string[] = [];
  let total = 0;
  for (const raw of (cap ?? '').split(',')) {
    const m = raw.trim().match(/^([A-Z0-9]+?)-(\d+)$/i);
    if (!m) continue;
    const n = Number(m[2]);
    total += n;
    const sys = m[1].toUpperCase().replace(/^DVB/, 'DVB-');
    parts.push(`${sys} ×${n}`);
  }
  return { total, parts };
}

/** Tiny tag reader for UPnP device descriptions (no XML dependency). */
export function xmlTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i'));
  return m ? m[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
}

export interface SatipDescription {
  friendlyName: string | null;
  manufacturer: string | null;
  modelName: string | null;
  modelNumber: string | null;
  capabilities: string | null;
  m3u: string | null;
  presentationUrl: string | null;
  tunerCount: number | null;
  tuners: string[];
  isFritzBox: boolean;
}

export function parseDescription(xml: string): SatipDescription {
  const cap = xmlTag(xml, 'X_SATIPCAP');
  const parsed = parseSatipCap(cap);
  const manufacturer = xmlTag(xml, 'manufacturer');
  const friendlyName = xmlTag(xml, 'friendlyName');
  return {
    friendlyName, manufacturer, modelName: xmlTag(xml, 'modelName'), modelNumber: xmlTag(xml, 'modelNumber'), capabilities: cap,
    m3u: xmlTag(xml, 'X_SATIPM3U'), presentationUrl: xmlTag(xml, 'presentationURL'),
    tunerCount: parsed.total || null, tuners: parsed.parts, isFritzBox: /\bAVM\b/i.test(manufacturer ?? '') || /fritz/i.test(friendlyName ?? ''),
  };
}

const hostOf = (url: string) => new URL(baseUrl(url)).hostname;

/** Places SAT>IP servers usually keep their description (tried when none was discovered). */
export function descriptionCandidates(url: string, explicit?: string | null): string[] {
  const out: string[] = [];
  if (explicit) out.push(explicit);
  if (/\.xml(\?|$)/i.test(url)) out.push(baseUrl(url));
  const h = hostOf(url);
  const host = h.includes(':') ? `[${h}]` : h;
  out.push(`http://${host}:49000/satipdesc.xml`, `http://${host}:8080/desc.xml`, `http://${host}/desc.xml`, `http://${host}:8875/desc.xml`);
  return [...new Set(out)];
}

export async function describe(s: SatipSourceLike, http = new TunerHttp({}, s.userAgent || 'Kinora/1.0')): Promise<(SatipDescription & { descriptionUrl: string }) | null> {
  // Tried in parallel (closed ports fail fast, a missing host would otherwise cost every timeout in turn); first in order wins.
  const urls = descriptionCandidates(s.url, s.options.descriptionUrl);
  const found = await Promise.all(urls.map(async (u) => {
    try {
      const xml = await http.text(u, 5000);
      return /X_SATIPCAP|SatIPServer/i.test(xml) ? { ...parseDescription(xml), descriptionUrl: u } : null;
    } catch {
      return null;
    }
  }));
  return found.find(Boolean) ?? null;
}

/**
 * Make a channel URL from a SAT>IP list absolute against the device: lists may use the "sat.ip" placeholder host,
 * a bare query ("?src=1&freq=…") or the device's own address.
 */
export function resolveSatipUrl(entry: string, deviceUrl: string): string {
  const host = hostOf(deviceUrl);
  const h = host.includes(':') ? `[${host}]` : host;
  const e = entry.trim();
  if (e.startsWith('?')) return `rtsp://${h}:554/${e}`;
  if (/^\/\?/.test(e)) return `rtsp://${h}:554${e}`;
  return e.replace(/^(rtsp|https?):\/\/(sat\.ip|satip|\{host\}|SATIP_HOST)(?=[:/?])/i, `$1://${h}`);
}

export async function sync(s: SatipSourceLike): Promise<TunerSync> {
  const http = new TunerHttp({}, s.userAgent || 'Kinora/1.0');
  const desc = await describe(s, http);
  const mode = s.options.satipMode ?? (desc?.isFritzBox ? 'fritzbox' : 'm3u');
  const warnings: string[] = [];
  const categories: TunerCategory[] = [];
  const channels: TunerChannel[] = [];
  const seen = new Set<string>();
  const add = (text: string, fallbackGroup: string | null) => {
    const pl = parseM3u(text);
    for (const e of pl.entries) {
      const url = resolveSatipUrl(e.url, s.url);
      if (!/^(rtsp|https?):\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      const group = e.group ?? fallbackGroup;
      if (group && !categories.some((c) => c.remoteId === group)) categories.push({ remoteId: group, name: FRITZ_LISTS[group] ?? group });
      channels.push({ remoteId: url.replace(/^[a-z]+:\/\/[^/]+/i, ''), name: e.name, number: e.chno ?? channels.length + 1, logo: e.logo, category: group, streamUrl: url, epgId: e.tvgId || e.tvgName || null });
    }
    return pl.entries.length;
  };
  if (mode === 'fritzbox') {
    const base = new URL(baseUrl(s.url)).origin;
    const lists = s.options.fritzLists?.length ? s.options.fritzLists.filter((l) => FRITZ_LISTS[l]) : ['tvhd', 'tvsd'];
    let ok = 0;
    for (const l of lists) {
      try {
        if (add(await http.text(`${base}/dvb/m3u/${l}.m3u`, 15000), l)) ok++;
      } catch (e) {
        warnings.push(`${l}.m3u: ${(e as Error).message}`);
      }
    }
    if (!ok) throw new TunerHttpError(`No channel lists on the FRITZ!Box (${warnings[0] ?? 'empty'}). Run the channel scan under DVB-C in the FRITZ!Box first.`);
  } else {
    const list = s.options.playlistUrl?.trim() || (/\.m3u8?(\?|$)/i.test(s.url) ? s.url.trim() : null) || desc?.m3u || null;
    if (!list) throw new TunerHttpError('Enter the URL of an M3U channel list with SAT>IP URLs for this server');
    const listUrl = /^https?:\/\//i.test(list) ? list : new URL(list, desc?.descriptionUrl ?? baseUrl(s.url)).toString();
    if (!add(await http.text(listUrl, 30000), null)) throw new TunerHttpError('The channel list has no entries');
  }
  if (!channels.length) throw new TunerHttpError('The channel list has no SAT>IP (rtsp:// or http://) entries');
  const device: TunerDevice = {
    name: desc?.friendlyName ?? (mode === 'fritzbox' ? 'FRITZ!Box' : 'SAT>IP server'), model: [desc?.manufacturer, desc?.modelName].filter(Boolean).join(' ') || null,
    version: desc?.modelNumber ?? null, tuners: desc?.tuners ?? [], tunerCount: desc?.tunerCount ?? null,
  };
  if (!desc) warnings.push('No SAT>IP device description found — tuner count unknown (set "Max streams" to limit it)');
  return { device, categories, channels, warnings };
}

/** FFmpeg input options for a SAT>IP URL. FRITZ!Box only streams RTP over UDP; most others accept TCP interleaving. */
export function ffmpegInputArgs(url: string, opts: TunerOptions, fritz: boolean): string[] {
  if (!/^rtsp:/i.test(url)) return [];
  const transport = opts.rtspTransport ?? (fritz || /[?&]avm=1/.test(url) ? 'udp' : 'tcp');
  return ['-rtsp_transport', transport];
}
