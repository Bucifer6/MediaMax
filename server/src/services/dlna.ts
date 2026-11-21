import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Item, User } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSettings, serverId } from './settings.js';
import { getBranding } from './branding.js';
import { getUser } from './auth.js';
import { allowedLibraryIds, getChildren, queryItems, getItem } from './items.js';
import { logger } from '../util/log.js';

/**
 * Minimal DLNA/UPnP AV MediaServer: SSDP discovery + ContentDirectory Browse.
 * Lets smart TVs, consoles, VLC, Kodi etc. browse and direct-play the library without an app.
 */
const log = logger('dlna');
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const DEVICE = 'urn:schemas-upnp-org:device:MediaServer:1';
const CDS = 'urn:schemas-upnp-org:service:ContentDirectory:1';
const CMS = 'urn:schemas-upnp-org:service:ConnectionManager:1';

export const dlnaUuid = () => {
  const h = crypto.createHash('sha1').update('mediamax-dlna:' + serverId()).digest('hex').slice(0, 32);
  return `uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

export function lanAddress(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

const baseUrl = () => `http://${lanAddress()}:${config.port}`;
const friendlyName = () => getSettings().dlna.friendlyName || getBranding().serverName || 'Kinora';

/** The account DLNA browses as. Must be chosen explicitly by an admin — there is no admin fallback. */
export function dlnaUser(): User | null {
  const id = getSettings().dlna.userId;
  if (!id) return null;
  try {
    const u = getUser(id);
    return u.disabled ? null : u;
  } catch {
    return null;
  }
}

/** DLNA streams are unauthenticated, so only serve the local network. */
export { isLocalAddress } from '../util/net.js';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function deviceDescription(): string {
  const b = getBranding();
  const icon = b.logoUrl ? `<iconList><icon><mimetype>image/png</mimetype><width>256</width><height>256</height><depth>24</depth><url>${esc(b.logoUrl)}</url></icon></iconList>` : '';
  return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>${DEVICE}</deviceType>
    <friendlyName>${esc(friendlyName())}</friendlyName>
    <manufacturer>Kinora</manufacturer>
    <modelName>Kinora Server</modelName>
    <modelNumber>${config.version}</modelNumber>
    <UDN>${dlnaUuid()}</UDN>
    <dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>
    ${icon}
    <serviceList>
      <service><serviceType>${CDS}</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/dlna/ContentDirectory.xml</SCPDURL><controlURL>/dlna/control/ContentDirectory</controlURL><eventSubURL>/dlna/event/ContentDirectory</eventSubURL></service>
      <service><serviceType>${CMS}</serviceType><serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/dlna/ConnectionManager.xml</SCPDURL><controlURL>/dlna/control/ConnectionManager</controlURL><eventSubURL>/dlna/event/ConnectionManager</eventSubURL></service>
    </serviceList>
    <presentationURL>/</presentationURL>
  </device>
</root>`;
}

const arg = (name: string, dir: 'in' | 'out', v: string) => `<argument><name>${name}</name><direction>${dir}</direction><relatedStateVariable>${v}</relatedStateVariable></argument>`;
const sv = (name: string, type: string, events = 'no') => `<stateVariable sendEvents="${events}"><name>${name}</name><dataType>${type}</dataType></stateVariable>`;

export const contentDirectoryScpd = () => `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>
<actionList>
  <action><name>Browse</name><argumentList>${arg('ObjectID', 'in', 'A_ARG_TYPE_ObjectID')}${arg('BrowseFlag', 'in', 'A_ARG_TYPE_BrowseFlag')}${arg('Filter', 'in', 'A_ARG_TYPE_Filter')}${arg('StartingIndex', 'in', 'A_ARG_TYPE_Index')}${arg('RequestedCount', 'in', 'A_ARG_TYPE_Count')}${arg('SortCriteria', 'in', 'A_ARG_TYPE_SortCriteria')}${arg('Result', 'out', 'A_ARG_TYPE_Result')}${arg('NumberReturned', 'out', 'A_ARG_TYPE_Count')}${arg('TotalMatches', 'out', 'A_ARG_TYPE_Count')}${arg('UpdateID', 'out', 'A_ARG_TYPE_UpdateID')}</argumentList></action>
  <action><name>GetSearchCapabilities</name><argumentList>${arg('SearchCaps', 'out', 'SearchCapabilities')}</argumentList></action>
  <action><name>GetSortCapabilities</name><argumentList>${arg('SortCaps', 'out', 'SortCapabilities')}</argumentList></action>
  <action><name>GetSystemUpdateID</name><argumentList>${arg('Id', 'out', 'SystemUpdateID')}</argumentList></action>
</actionList>
<serviceStateTable>${sv('A_ARG_TYPE_ObjectID', 'string')}${sv('A_ARG_TYPE_Result', 'string')}${sv('A_ARG_TYPE_BrowseFlag', 'string')}${sv('A_ARG_TYPE_Filter', 'string')}${sv('A_ARG_TYPE_SortCriteria', 'string')}${sv('A_ARG_TYPE_Index', 'ui4')}${sv('A_ARG_TYPE_Count', 'ui4')}${sv('A_ARG_TYPE_UpdateID', 'ui4')}${sv('SearchCapabilities', 'string')}${sv('SortCapabilities', 'string')}${sv('SystemUpdateID', 'ui4', 'yes')}</serviceStateTable>
</scpd>`;

export const connectionManagerScpd = () => `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>
<actionList>
  <action><name>GetProtocolInfo</name><argumentList>${arg('Source', 'out', 'SourceProtocolInfo')}${arg('Sink', 'out', 'SinkProtocolInfo')}</argumentList></action>
  <action><name>GetCurrentConnectionIDs</name><argumentList>${arg('ConnectionIDs', 'out', 'CurrentConnectionIDs')}</argumentList></action>
</actionList>
<serviceStateTable>${sv('SourceProtocolInfo', 'string', 'yes')}${sv('SinkProtocolInfo', 'string', 'yes')}${sv('CurrentConnectionIDs', 'string', 'yes')}</serviceStateTable>
</scpd>`;

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ts: 'video/mp2t', mov: 'video/quicktime', webm: 'video/webm', wmv: 'video/x-ms-wmv',
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

function duration(ms: number | null | undefined) {
  const t = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.000`;
}

function containerXml(id: string, parentId: string, title: string, childCount: number, upnpClass: string, art?: string | null) {
  return `<container id="${esc(id)}" parentID="${esc(parentId)}" restricted="1" childCount="${childCount}" searchable="0"><dc:title>${esc(title)}</dc:title><upnp:class>${upnpClass}</upnp:class>${art ? `<upnp:albumArtURI>${esc(baseUrl() + art)}</upnp:albumArtURI>` : ''}</container>`;
}

function itemXml(item: Item, parentId: string): string {
  const media = db.get('SELECT * FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', item.id);
  if (!media) return '';
  const ext = (media.container ?? 'mp4').toLowerCase();
  const mime = MIME[ext] ?? (item.type === 'track' ? 'audio/mpeg' : item.type === 'photo' ? 'image/jpeg' : 'video/mp4');
  const cls = item.type === 'track' ? 'object.item.audioItem.musicTrack' : item.type === 'photo' ? 'object.item.imageItem.photo' : 'object.item.videoItem.movie';
  const attrs = [`protocolInfo="http-get:*:${mime}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"`];
  if (media.size) attrs.push(`size="${media.size}"`);
  if (media.duration_ms) attrs.push(`duration="${duration(media.duration_ms)}"`);
  if (media.width && media.height) attrs.push(`resolution="${media.width}x${media.height}"`);
  if (media.bitrate) attrs.push(`bitrate="${Math.round((media.bitrate * 1000) / 8)}"`);
  const title = item.type === 'episode' ? `${item.index != null ? `${item.index}. ` : ''}${item.title}` : item.title;
  const art = item.thumbUrl ?? item.posterUrl;
  const extra = item.type === 'track'
    ? `<upnp:artist>${esc(item.grandparentTitle)}</upnp:artist><upnp:album>${esc(item.parentTitle)}</upnp:album>${item.index ? `<upnp:originalTrackNumber>${item.index}</upnp:originalTrackNumber>` : ''}`
    : `${item.overview ? `<dc:description>${esc(item.overview.slice(0, 500))}</dc:description>` : ''}${item.genres[0] ? `<upnp:genre>${esc(item.genres[0])}</upnp:genre>` : ''}`;
  const subs = JSON.parse(media.subs || '[]').filter((s: any) => ['subrip', 'srt', 'webvtt'].includes(s.codec)).slice(0, 1);
  const subRes = subs.map((s: any) => `<res protocolInfo="http-get:*:text/srt:*">${esc(`${baseUrl()}/dlna/subtitle/${media.id}/${s.index}.srt`)}</res>`).join('');
  return `<item id="item:${esc(item.id)}" parentID="${esc(parentId)}" restricted="1"><dc:title>${esc(title)}</dc:title><upnp:class>${cls}</upnp:class>${item.year ? `<dc:date>${item.year}-01-01</dc:date>` : ''}${extra}${art ? `<upnp:albumArtURI dlna:profileID="JPEG_TN">${esc(baseUrl() + art + '?w=320')}</upnp:albumArtURI>` : ''}<res ${attrs.join(' ')}>${esc(`${baseUrl()}/dlna/stream/${media.id}.${ext}`)}</res>${subRes}</item>`;
}

const DIDL_OPEN = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">';

const CONTAINER_TYPES = new Set(['show', 'season', 'artist', 'album', 'collection', 'playlist']);
const containerClass = (t: string) => (t === 'album' ? 'object.container.album.musicAlbum' : t === 'artist' ? 'object.container.person.musicArtist' : 'object.container.storageFolder');

export function browse(objectId: string, flag: string, start: number, count: number): { result: string; returned: number; total: number } {
  const user = dlnaUser();
  if (!user) return { result: DIDL_OPEN + '</DIDL-Lite>', returned: 0, total: 0 };
  const limit = count > 0 ? Math.min(count, 500) : 500;
  const parts: string[] = [];
  let total = 0;
  if (objectId === '0') {
    // IPTV libraries are excluded: their files live on the provider and need the app's proxy/transcoder.
    const libs = db.all("SELECT * FROM libraries WHERE type NOT LIKE 'iptv-%' ORDER BY sort_order, name").filter((l) => allowedLibraryIds(user).includes(l.id));
    if (flag === 'BrowseMetadata') return { result: `${DIDL_OPEN}${containerXml('0', '-1', friendlyName(), libs.length, 'object.container.storageFolder')}</DIDL-Lite>`, returned: 1, total: 1 };
    total = libs.length;
    for (const l of libs.slice(start, start + limit)) parts.push(containerXml(`lib:${l.id}`, '0', l.name, 1, 'object.container.storageFolder'));
  } else if (objectId.startsWith('lib:')) {
    const libId = objectId.slice(4);
    const lib = db.get('SELECT * FROM libraries WHERE id = ?', libId);
    if (!lib || !allowedLibraryIds(user).includes(libId)) return { result: DIDL_OPEN + '</DIDL-Lite>', returned: 0, total: 0 };
    if (flag === 'BrowseMetadata') return { result: `${DIDL_OPEN}${containerXml(objectId, '0', lib.name, 1, 'object.container.storageFolder')}</DIDL-Lite>`, returned: 1, total: 1 };
    const page = queryItems(user, { libraryId: libId, sort: 'title', limit, offset: start });
    total = page.total;
    for (const it of page.items) parts.push(CONTAINER_TYPES.has(it.type) ? containerXml(`item:${it.id}`, objectId, it.title, it.childCount, containerClass(it.type), it.posterUrl) : itemXml(it, objectId));
  } else if (objectId.startsWith('item:')) {
    const id = objectId.slice(5);
    let it: Item;
    try {
      it = getItem(user, id, false);
    } catch {
      return { result: DIDL_OPEN + '</DIDL-Lite>', returned: 0, total: 0 };
    }
    const parent = it.parentId ? `item:${it.parentId}` : it.libraryId ? `lib:${it.libraryId}` : '0';
    if (flag === 'BrowseMetadata') {
      const x = CONTAINER_TYPES.has(it.type) ? containerXml(objectId, parent, it.title, it.childCount, containerClass(it.type), it.posterUrl) : itemXml(it, parent);
      return { result: `${DIDL_OPEN}${x}</DIDL-Lite>`, returned: 1, total: 1 };
    }
    const page = getChildren(user, id, { limit, offset: start });
    total = page.total;
    for (const c of page.items) parts.push(CONTAINER_TYPES.has(c.type) ? containerXml(`item:${c.id}`, objectId, c.type === 'season' ? c.title : c.title, c.childCount, containerClass(c.type), c.posterUrl) : itemXml(c, objectId));
  }
  const xml = parts.filter(Boolean);
  return { result: `${DIDL_OPEN}${xml.join('')}</DIDL-Lite>`, returned: xml.length, total };
}

export function soapResponse(service: string, action: string, values: Record<string, string | number>): string {
  const body = Object.entries(values).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${service}">${body}</u:${action}Response></s:Body></s:Envelope>`;
}

export function soapArg(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? m[1].trim() : '';
}

export const systemUpdateId = () => db.get<{ n: number }>("SELECT COUNT(*) + COALESCE(SUM(LENGTH(updated_at)), 0) % 100000 n FROM items")?.n ?? 1;

/* -------------------------------- SSDP ------------------------------ */

let socket: dgram.Socket | null = null;
let notifyTimer: NodeJS.Timeout | null = null;

function ssdpTargets(): [string, string][] {
  const uuid = dlnaUuid();
  return [['upnp:rootdevice', `${uuid}::upnp:rootdevice`], [uuid, uuid], [DEVICE, `${uuid}::${DEVICE}`], [CDS, `${uuid}::${CDS}`], [CMS, `${uuid}::${CMS}`]];
}

const location = () => `${baseUrl()}/dlna/description.xml`;
const SERVER_HDR = `${os.type()}/${os.release()} UPnP/1.0 Kinora/${config.version}`;

function notify(type: 'ssdp:alive' | 'ssdp:byebye') {
  if (!socket) return;
  for (const [nt, usn] of ssdpTargets()) {
    const msg = ['NOTIFY * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, `NT: ${nt}`, `NTS: ${type}`, `USN: ${usn}`,
      ...(type === 'ssdp:alive' ? ['CACHE-CONTROL: max-age=1800', `LOCATION: ${location()}`, `SERVER: ${SERVER_HDR}`] : []), '', ''].join('\r\n');
    socket.send(msg, SSDP_PORT, SSDP_ADDR);
  }
}

export function startDlna() {
  if (socket || !getSettings().dlna.enabled) return;
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('error', (e) => {
    log.warn(`SSDP socket error: ${e.message}`);
    stopDlna();
  });
  s.on('message', (msg, rinfo) => {
    const text = msg.toString();
    if (!text.startsWith('M-SEARCH')) return;
    const st = text.match(/^ST:\s*(.+)$/im)?.[1].trim();
    if (!st) return;
    for (const [nt, usn] of ssdpTargets()) {
      if (st !== 'ssdp:all' && st !== nt) continue;
      const res = ['HTTP/1.1 200 OK', 'CACHE-CONTROL: max-age=1800', `DATE: ${new Date().toUTCString()}`, 'EXT:', `LOCATION: ${location()}`, `SERVER: ${SERVER_HDR}`, `ST: ${nt}`, `USN: ${usn}`, '', ''].join('\r\n');
      s.send(res, rinfo.port, rinfo.address);
    }
  });
  s.bind(SSDP_PORT, () => {
    try {
      s.addMembership(SSDP_ADDR);
      s.setMulticastTTL(4);
    } catch (e) {
      log.warn(`Could not join SSDP multicast group: ${(e as Error).message}`);
    }
    socket = s;
    notify('ssdp:alive');
    notifyTimer = setInterval(() => notify('ssdp:alive'), 15 * 60000);
    log.info(`DLNA server "${friendlyName()}" announced at ${location()}`);
  });
}

export function stopDlna() {
  if (notifyTimer) clearInterval(notifyTimer);
  notifyTimer = null;
  if (socket) {
    try {
      notify('ssdp:byebye');
      socket.close();
    } catch {
      /* ignore */
    }
  }
  socket = null;
}

export function syncDlna() {
  if (getSettings().dlna.enabled) startDlna();
  else stopDlna();
}
