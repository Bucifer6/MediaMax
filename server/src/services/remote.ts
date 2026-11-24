import dgram from 'node:dgram';
import type { RemoteAccessStatus } from '@mediamax/shared';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { lanAddress } from './dlna.js';
import { logger } from '../util/log.js';

/**
 * Remote access helper: asks the router (UPnP IGD) to forward a port to this server, renews the
 * lease, and reports the external IP. No relay — traffic goes directly to your server.
 */
const log = logger('remote');
const status: RemoteAccessStatus['upnp'] = { enabled: false, mapped: false, externalIp: null, externalPort: null, router: null, error: null, lastCheckedAt: null };
let timer: NodeJS.Timeout | null = null;
let control: { url: string; service: string } | null = null;

function discoverGateway(timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = (v: string | null) => {
      clearTimeout(t);
      try {
        s.close();
      } catch {
        /* closed */
      }
      resolve(v);
    };
    const t = setTimeout(() => done(null), timeoutMs);
    s.on('message', (m) => {
      const loc = m.toString().match(/^LOCATION:\s*(\S+)/im)?.[1];
      if (loc) done(loc);
    });
    s.on('error', () => done(null));
    s.bind(() => {
      for (const st of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1']) {
        s.send(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`, Number(process.env.MEDIAMAX_UPNP_SSDP_PORT ?? 1900), process.env.MEDIAMAX_UPNP_SSDP_ADDR ?? '239.255.255.250');
      }
    });
  });
}

async function findControl(location: string): Promise<{ url: string; service: string; name: string } | null> {
  const xml = await (await fetch(location, { signal: AbortSignal.timeout(5000) })).text();
  const name = xml.match(/<friendlyName>([^<]+)<\/friendlyName>/)?.[1] ?? 'Router';
  for (const service of ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1']) {
    const i = xml.indexOf(`<serviceType>${service}</serviceType>`);
    if (i < 0) continue;
    const block = xml.slice(i, xml.indexOf('</service>', i));
    const ctl = block.match(/<controlURL>([^<]+)<\/controlURL>/)?.[1];
    if (ctl) return { url: new URL(ctl, location).toString(), service, name };
  }
  return null;
}

async function soap(action: string, args: Record<string, string | number>): Promise<string> {
  if (!control) throw new Error('No router');
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${control.service}">${Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(control.url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${control.service}#${action}"` }, body, signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  if (!res.ok) throw new Error(text.match(/<errorDescription>([^<]+)/)?.[1] ?? `Router returned HTTP ${res.status}`);
  return text;
}

export async function refreshMapping(): Promise<RemoteAccessStatus['upnp']> {
  const s = getSettings().remoteAccess;
  status.enabled = s.upnp;
  status.lastCheckedAt = new Date().toISOString();
  if (!s.upnp) {
    if (status.mapped) await removeMapping();
    return status;
  }
  const port = s.externalPort || config.port;
  try {
    if (!control) {
      const loc = await discoverGateway();
      if (!loc) throw new Error('No UPnP router found on the network (UPnP may be disabled on the router, or Vibe runs in an isolated Docker network — use host networking).');
      const c = await findControl(loc);
      if (!c) throw new Error('The router does not offer port forwarding over UPnP');
      control = c;
      status.router = c.name;
    }
    await soap('AddPortMapping', {
      NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP', NewInternalPort: config.port, NewInternalClient: lanAddress(),
      NewEnabled: 1, NewPortMappingDescription: 'Vibe', NewLeaseDuration: 3600,
    });
    const ipXml = await soap('GetExternalIPAddress', {});
    status.externalIp = ipXml.match(/<NewExternalIPAddress>([^<]*)</)?.[1] || null;
    status.externalPort = port;
    status.mapped = true;
    status.error = null;
  } catch (e) {
    control = null;
    status.mapped = false;
    status.error = (e as Error).message;
    log.warn(`UPnP: ${status.error}`);
  }
  return status;
}

async function removeMapping() {
  try {
    await soap('DeletePortMapping', { NewRemoteHost: '', NewExternalPort: status.externalPort ?? config.port, NewProtocol: 'TCP' });
  } catch {
    /* best effort */
  }
  status.mapped = false;
  status.externalIp = null;
  status.externalPort = null;
}

export function remoteStatus(): RemoteAccessStatus {
  return { lanAddress: lanAddress(), port: config.port, publicUrl: getSettings().publicUrl, upnp: { ...status, enabled: getSettings().remoteAccess.upnp } };
}

export function startRemoteAccess() {
  void refreshMapping();
  timer = setInterval(() => void refreshMapping(), 30 * 60000);
}

export async function stopRemoteAccess() {
  if (timer) clearInterval(timer);
  if (status.mapped) await removeMapping();
}
