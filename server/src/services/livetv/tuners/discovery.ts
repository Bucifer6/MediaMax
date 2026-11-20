/**
 * LAN discovery of tuner devices:
 *  - SAT>IP servers by SSDP (M-SEARCH for urn:ses-com:device:SatIPServer:1 on 239.255.255.250:1900), then their
 *    UPnP description for name, maker and <satip:X_SATIPCAP> tuner capabilities.
 *  - HDHomeRun tuners by SiliconDust's UDP discovery (broadcast to port 65001).
 * Both need the server on the same layer-2 network (Docker: host networking).
 */
import dgram from 'node:dgram';
import { TunerHttp } from './http.js';
import { parseDescription } from './satip.js';

export const SATIP_ST = 'urn:ses-com:device:SatIPServer:1';

export interface DiscoveredDevice {
  kind: 'satip' | 'hdhomerun';
  name: string;
  manufacturer: string | null;
  model: string | null;
  /** Base address to enter as the source URL. */
  address: string;
  descriptionUrl: string | null;
  tunerCount: number | null;
  capabilities: string | null;
  isFritzBox: boolean;
  deviceId: string | null;
}

/** Target for the M-SEARCH (overridable for tests: MEDIAMAX_SSDP_TARGET=127.0.0.1:12345). */
const ssdpTarget = () => {
  const t = process.env.MEDIAMAX_SSDP_TARGET;
  if (t) {
    const [host, port] = t.split(':');
    return { host, port: Number(port) };
  }
  return { host: '239.255.255.250', port: 1900 };
};

export function parseSsdpResponse(msg: string): { location: string | null; st: string | null; usn: string | null } {
  const h: Record<string, string> = {};
  for (const line of msg.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { location: h.location ?? null, st: h.st ?? h.nt ?? null, usn: h.usn ?? null };
}

export async function discoverSatip(timeoutMs = 2500): Promise<DiscoveredDevice[]> {
  const { host, port } = ssdpTarget();
  const locations = new Map<string, string | null>();
  await new Promise<void>((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve();
    };
    sock.on('error', done);
    sock.on('message', (buf) => {
      const r = parseSsdpResponse(buf.toString('utf8'));
      if (r.location && (!r.st || /SatIPServer/i.test(r.st) || /SatIPServer/i.test(r.usn ?? ''))) locations.set(r.location, r.usn);
    });
    sock.bind(0, () => {
      const msg = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: 239.255.255.250:1900`, 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${SATIP_ST}`, '', ''].join('\r\n'));
      try {
        if (host.startsWith('239.')) sock.setMulticastTTL(2);
      } catch {
        /* not fatal */
      }
      // Sent twice: UDP on Wi-Fi drops packets.
      sock.send(msg, port, host);
      setTimeout(() => sock.send(msg, port, host, () => undefined), 300);
      setTimeout(done, timeoutMs);
    });
  });
  const http = new TunerHttp();
  const out: DiscoveredDevice[] = [];
  await Promise.all([...locations].map(async ([loc, usn]) => {
    try {
      const d = parseDescription(await http.text(loc, 4000));
      const u = new URL(loc);
      out.push({
        kind: 'satip', name: d.friendlyName ?? u.hostname, manufacturer: d.manufacturer, model: d.modelName, address: `http://${u.hostname}`, descriptionUrl: loc,
        tunerCount: d.tunerCount, capabilities: d.capabilities, isFritzBox: d.isFritzBox, deviceId: usn?.match(/uuid:([^:]+)/)?.[1] ?? null,
      });
    } catch {
      /* unreachable description */
    }
  }));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------ HDHomeRun ------------------------------ */

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** HDHomeRun discover request: type 0x0002, tags device type = tuner, device id = wildcard; CRC32 little-endian. */
export function hdhrDiscoverPacket(): Buffer {
  const payload = Buffer.from([0x01, 0x04, 0x00, 0x00, 0x00, 0x01, 0x02, 0x04, 0xff, 0xff, 0xff, 0xff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0x0002, 0);
  head.writeUInt16BE(payload.length, 2);
  const body = Buffer.concat([head, payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(body), 0);
  return Buffer.concat([body, crc]);
}

export function parseHdhrReply(buf: Buffer, from: string): DiscoveredDevice | null {
  if (buf.length < 8 || buf.readUInt16BE(0) !== 0x0003) return null;
  const len = buf.readUInt16BE(2);
  if (buf.length < 4 + len + 4 || crc32(buf.subarray(0, 4 + len)) !== buf.readUInt32LE(4 + len)) return null;
  let i = 4;
  let deviceId: string | null = null;
  let tuners: number | null = null;
  let baseUrl: string | null = null;
  while (i < 4 + len) {
    const tag = buf[i++];
    let l = buf[i++];
    if (l & 0x80) l = (l & 0x7f) | (buf[i++] << 7);
    const v = buf.subarray(i, i + l);
    i += l;
    if (tag === 0x02 && l === 4) deviceId = v.readUInt32BE(0).toString(16).toUpperCase().padStart(8, '0');
    else if (tag === 0x10 && l >= 1) tuners = v[0];
    else if (tag === 0x2a) baseUrl = v.toString('utf8');
  }
  return {
    kind: 'hdhomerun', name: `HDHomeRun ${deviceId ?? from}`, manufacturer: 'SiliconDust', model: null, address: baseUrl ?? `http://${from}`, descriptionUrl: null,
    tunerCount: tuners, capabilities: null, isFritzBox: false, deviceId,
  };
}

export async function discoverHdhomerun(timeoutMs = 1500): Promise<DiscoveredDevice[]> {
  const target = process.env.MEDIAMAX_HDHR_DISCOVER_TARGET;
  const [host, port] = target ? [target.split(':')[0], Number(target.split(':')[1])] : ['255.255.255.255', 65001];
  const found = new Map<string, DiscoveredDevice>();
  await new Promise<void>((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = () => {
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve();
    };
    sock.on('error', done);
    sock.on('message', (buf, rinfo) => {
      const d = parseHdhrReply(buf, rinfo.address);
      if (d) found.set(d.deviceId ?? d.address, d);
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        /* not fatal */
      }
      sock.send(hdhrDiscoverPacket(), port, host, () => undefined);
      setTimeout(done, timeoutMs);
    });
  });
  return [...found.values()];
}

export async function discoverAll(): Promise<DiscoveredDevice[]> {
  const [a, b] = await Promise.all([discoverSatip().catch(() => []), discoverHdhomerun().catch(() => [])]);
  return [...a, ...b];
}
