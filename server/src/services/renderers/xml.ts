/**
 * XML helpers for UPnP AV control: escaping, DIDL-Lite metadata, SOAP envelopes, and the H:MM:SS
 * time format AVTransport uses. Pure functions (unit-tested).
 */

/** Escape text for an XML element body or a double-quoted attribute. Strips characters XML 1.0 forbids. */
export function xmlEscape(s: unknown): string {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** ms → "H:MM:SS" (AVTransport REL_TIME / duration; DIDL res@duration adds ".mmm"). */
export function formatHms(ms: number, withMillis = false): string {
  const total = Math.max(0, Math.floor(ms));
  const sec = Math.floor(total / 1000);
  const base = `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  return withMillis ? `${base}.${String(total % 1000).padStart(3, '0')}` : base;
}

/** "H:MM:SS[.fff]" / "NOT_IMPLEMENTED" / "" → ms (null when unknown). */
export function parseHms(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?(?:\/\d+)?$/);
  if (!m) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return Math.round(((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) + frac) * 1000);
}

/** First element named `name` (any namespace prefix); returns its raw (still escaped) inner text. */
export function xmlTag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`));
  if (m) return m[1].trim();
  return new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?/>`).test(xml) ? '' : null;
}

export const xmlText = (xml: string, name: string) => {
  const v = xmlTag(xml, name);
  return v == null ? null : xmlUnescape(v);
};

/* -------------------------------- SOAP ------------------------------- */

export function soapEnvelope(serviceType: string, action: string, args: [string, string | number][]): string {
  const body = args.map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${xmlEscape(serviceType)}">${body}</u:${action}></s:Body></s:Envelope>`;
}

/** UPnP error from a SOAP fault, e.g. { code: 701, description: "Transition not available" }. */
export function soapFault(xml: string): { code: number | null; description: string } | null {
  if (!/Fault>/.test(xml)) return null;
  const code = xmlText(xml, 'errorCode');
  return { code: code ? Number(code) : null, description: xmlText(xml, 'errorDescription') ?? xmlText(xml, 'faultstring') ?? 'UPnP error' };
}

/* ------------------------------ DIDL-Lite ---------------------------- */

export interface DidlRes {
  url: string;
  protocolInfo: string;
  durationMs?: number | null;
  size?: number | null;
  resolution?: string | null;
  bitrate?: number | null;
}

export interface DidlItem {
  id: string;
  title: string;
  /** e.g. object.item.videoItem.movie, object.item.audioItem.musicTrack */
  upnpClass: string;
  artist?: string | null;
  album?: string | null;
  creator?: string | null;
  genre?: string | null;
  description?: string | null;
  trackNumber?: number | null;
  date?: string | null;
  artUrl?: string | null;
  res: DidlRes;
  /** External SRT subtitle (Samsung CaptionInfoEx + a text/srt res for LG and others). */
  subtitleUrl?: string | null;
}

const DIDL_NS = 'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/" xmlns:sec="http://www.sec.co.kr/"';

/** DIDL-Lite document for one item (as used in SetAVTransportURI CurrentURIMetaData). Every value is XML-escaped. */
export function didlLite(i: DidlItem): string {
  const e = xmlEscape;
  const opt = (tag: string, v: unknown) => (v == null || v === '' ? '' : `<${tag}>${e(v)}</${tag}>`);
  const r = i.res;
  const attrs = [`protocolInfo="${e(r.protocolInfo)}"`];
  if (r.durationMs) attrs.push(`duration="${formatHms(r.durationMs, true)}"`);
  if (r.size) attrs.push(`size="${Math.round(r.size)}"`);
  if (r.resolution) attrs.push(`resolution="${e(r.resolution)}"`);
  if (r.bitrate) attrs.push(`bitrate="${Math.round(r.bitrate)}"`);
  const subs = i.subtitleUrl
    ? `<sec:CaptionInfoEx sec:type="srt">${e(i.subtitleUrl)}</sec:CaptionInfoEx><sec:CaptionInfo sec:type="srt">${e(i.subtitleUrl)}</sec:CaptionInfo>`
    : '';
  const subRes = i.subtitleUrl ? `<res protocolInfo="http-get:*:text/srt:*">${e(i.subtitleUrl)}</res>` : '';
  return `<DIDL-Lite ${DIDL_NS}><item id="${e(i.id)}" parentID="0" restricted="1">`
    + `<dc:title>${e(i.title)}</dc:title>`
    + opt('dc:creator', i.creator ?? i.artist)
    + opt('upnp:artist', i.artist)
    + opt('upnp:album', i.album)
    + opt('upnp:genre', i.genre)
    + opt('dc:description', i.description ? i.description.slice(0, 500) : null)
    + opt('upnp:originalTrackNumber', i.trackNumber)
    + opt('dc:date', i.date)
    + (i.artUrl ? `<upnp:albumArtURI dlna:profileID="JPEG_TN">${e(i.artUrl)}</upnp:albumArtURI>` : '')
    + `<upnp:class>${e(i.upnpClass)}</upnp:class>`
    + `<res ${attrs.join(' ')}>${e(r.url)}</res>`
    + subRes + subs
    + '</item></DIDL-Lite>';
}

/* ----------------------------- protocolInfo -------------------------- */

/** DLNA flags: streaming transfer + background + connection stall + DLNA 1.5. */
export const DLNA_FLAGS = '01700000000000000000000000000000';

/** The 4th protocolInfo field. Direct files allow byte seeks (OP=01); live transcodes don't (OP=00, CI=1). */
export function dlnaFeatures(o: { pn?: string | null; transcoded: boolean }): string {
  return [o.pn ? `DLNA.ORG_PN=${o.pn}` : null, `DLNA.ORG_OP=${o.transcoded ? '00' : '01'}`, `DLNA.ORG_CI=${o.transcoded ? 1 : 0}`, `DLNA.ORG_FLAGS=${DLNA_FLAGS}`].filter(Boolean).join(';');
}

export const protocolInfo = (mime: string, features: string) => `http-get:*:${mime}:${features}`;

export interface SinkEntry {
  protocol: string;
  mime: string;
  /** DLNA.ORG_PN value when listed. */
  pn: string | null;
}

/** Parse a ConnectionManager Sink list ("http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_...,http-get:*:audio/mpeg:*"). */
export function parseSinkList(sink: string): SinkEntry[] {
  return sink.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [protocol = '', , mime = '', extra = ''] = s.split(':');
    return { protocol: protocol.toLowerCase(), mime: mime.toLowerCase(), pn: extra.match(/DLNA\.ORG_PN=([^;]+)/)?.[1] ?? null };
  }).filter((e) => e.protocol === 'http-get');
}
