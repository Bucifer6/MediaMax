import { USER_AGENT } from '../../util/userAgent.js';
import dgram from 'node:dgram';
import { XMLParser } from 'fast-xml-parser';
import { deviceFetch, isLanAddress } from './lan.js';
import { logger } from '../../util/log.js';

const log = logger('renderers');

export const MEDIA_RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1';
export const ZONE_PLAYER = 'urn:schemas-upnp-org:device:ZonePlayer:1';
export const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
export const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';
export const CMS = 'urn:schemas-upnp-org:service:ConnectionManager:1';
export const GRC = 'urn:schemas-upnp-org:service:GroupRenderingControl:1';

export interface SsdpHit {
  location: string;
  address: string;
  st: string;
  usn: string;
  server: string;
}

/** Parse an SSDP M-SEARCH response or NOTIFY into its headers. */
export function parseSsdp(text: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}

const ssdpTarget = () => ({ addr: process.env.MEDIAMAX_RENDERER_SSDP_ADDR ?? '239.255.255.250', port: Number(process.env.MEDIAMAX_RENDERER_SSDP_PORT ?? 1900) });

/**
 * Multicast M-SEARCH for media renderers (and Sonos zone players). Only answers from LAN addresses
 * whose LOCATION points back at the answering host are kept.
 */
export function ssdpSearch(timeoutMs = 3000, targets = [MEDIA_RENDERER, ZONE_PLAYER]): Promise<SsdpHit[]> {
  return new Promise((resolve) => {
    const hits = new Map<string, SsdpHit>();
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        s.close();
      } catch {
        /* closed */
      }
      resolve([...hits.values()]);
    };
    const timer = setTimeout(done, timeoutMs);
    s.on('error', (e) => {
      log.warn(`SSDP search failed: ${e.message}`);
      done();
    });
    s.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/^HTTP\/1\.1 200/i.test(text) && !/^NOTIFY/i.test(text)) return;
      const h = parseSsdp(text);
      const location = h.location;
      const st = h.st ?? h.nt ?? '';
      if (!location || !targets.some((t) => st === t)) return;
      if (!isLanAddress(rinfo.address)) return;
      let host: string;
      try {
        host = new URL(location).hostname;
      } catch {
        return;
      }
      // The description must live on the device that answered (no pointing the server at other hosts).
      if (host !== rinfo.address) return;
      if (!hits.has(location)) hits.set(location, { location, address: rinfo.address, st, usn: h.usn ?? '', server: h.server ?? '' });
    });
    s.bind(0, () => {
      const { addr, port } = ssdpTarget();
      try {
        s.setMulticastTTL(2);
      } catch {
        /* unicast test target */
      }
      for (const st of targets) {
        const m = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\nUSER-AGENT: Node/${process.versions.node} UPnP/1.1 ${USER_AGENT}\r\n\r\n`;
        // Send twice: UDP multicast is lossy.
        s.send(m, port, addr);
        setTimeout(() => !finished && s.send(m, port, addr), 300);
      }
    });
  });
}

/* --------------------------- device description ------------------------ */

export interface ServiceRef {
  serviceType: string;
  controlUrl: string;
}

export interface DeviceDescription {
  udn: string;
  friendlyName: string;
  manufacturer: string | null;
  modelName: string | null;
  deviceType: string;
  iconUrl: string | null;
  avTransport: ServiceRef | null;
  renderingControl: ServiceRef | null;
  connectionManager: ServiceRef | null;
  groupRenderingControl: ServiceRef | null;
  isSonos: boolean;
  /** Sonos player id (RINCON_xxxxxxxxxxxx01400) for queue URIs. */
  rinconId: string | null;
}

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true, isArray: (name) => ['device', 'service', 'icon'].includes(name) });

const str = (v: unknown) => (v == null ? null : typeof v === 'object' ? null : String(v));

interface RawDevice {
  deviceType?: string;
  friendlyName?: string;
  manufacturer?: string;
  modelName?: string;
  UDN?: string;
  iconList?: { icon?: { mimetype?: string; width?: string; url?: string }[] };
  serviceList?: { service?: { serviceType?: string; controlURL?: string }[] };
  deviceList?: { device?: RawDevice[] };
}

function walk(d: RawDevice, out: RawDevice[] = []): RawDevice[] {
  out.push(d);
  for (const c of d.deviceList?.device ?? []) walk(c, out);
  return out;
}

/** Parse a UPnP device description. Returns null if it has no MediaRenderer with an AVTransport service. */
export function parseDescription(xml: string, location: string): DeviceDescription | null {
  let doc: { root?: { URLBase?: string; device?: RawDevice[] } };
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const root = doc.root?.device?.[0];
  if (!root) return null;
  const base = str(doc.root?.URLBase) || location;
  const all = walk(root);
  const svc = (d: RawDevice, type: string): ServiceRef | null => {
    const s = (d.serviceList?.service ?? []).find((x) => str(x.serviceType)?.startsWith(type.replace(/:1$/, ':')));
    const ctl = s && str(s.controlURL);
    if (!s || !ctl) return null;
    try {
      return { serviceType: str(s.serviceType)!, controlUrl: new URL(ctl, base).toString() };
    } catch {
      return null;
    }
  };
  const renderer = all.find((d) => str(d.deviceType)?.startsWith('urn:schemas-upnp-org:device:MediaRenderer:') && svc(d, AVT)) ?? all.find((d) => svc(d, AVT));
  if (!renderer) return null;
  const manufacturer = str(root.manufacturer) ?? str(renderer.manufacturer);
  const udn = str(root.UDN) ?? str(renderer.UDN) ?? location;
  const isSonos = /sonos/i.test(manufacturer ?? '') || str(root.deviceType) === ZONE_PLAYER;
  const icons = [...(root.iconList?.icon ?? []), ...(renderer.iconList?.icon ?? [])].filter((i) => str(i.url));
  const icon = icons.find((i) => /png/.test(str(i.mimetype) ?? '')) ?? icons[0];
  let iconUrl: string | null = null;
  try {
    iconUrl = icon ? new URL(str(icon.url)!, base).toString() : null;
  } catch {
    iconUrl = null;
  }
  return {
    udn,
    friendlyName: str(root.friendlyName) ?? str(renderer.friendlyName) ?? 'Media renderer',
    manufacturer,
    modelName: str(root.modelName) ?? str(renderer.modelName),
    deviceType: str(renderer.deviceType) ?? MEDIA_RENDERER,
    iconUrl,
    avTransport: svc(renderer, AVT),
    renderingControl: svc(renderer, RCS),
    connectionManager: svc(renderer, CMS),
    groupRenderingControl: svc(renderer, GRC),
    isSonos,
    rinconId: isSonos ? udn.match(/RINCON_[0-9A-Fa-f]+/)?.[0] ?? null : null,
  };
}

/** Fetch and parse a description, keeping every URL on the description's own host. */
export async function fetchDescription(location: string): Promise<DeviceDescription | null> {
  const host = new URL(location).hostname;
  const res = await deviceFetch(location, host, { timeoutMs: 4000 });
  if (!res.ok) return null;
  const text = (await res.text()).slice(0, 512 * 1024);
  const d = parseDescription(text, location);
  if (!d) return null;
  for (const s of [d.avTransport, d.renderingControl, d.connectionManager, d.groupRenderingControl]) {
    if (s && new URL(s.controlUrl).hostname !== host) return null;
  }
  if (d.iconUrl && new URL(d.iconUrl).hostname !== host) d.iconUrl = null;
  return d;
}
