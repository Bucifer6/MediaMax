import dgram from 'node:dgram';
import { isLanAddress } from './lan.js';

/**
 * Tiny dependency-free mDNS browser: one PTR query for a service type, sent from an ephemeral port
 * (an RFC 6762 §6.7 "legacy unicast" query, so responders answer us directly), collecting the
 * SRV / A records of the answers. Enough to find Kodi's `_xbmc-jsonrpc-h._tcp` HTTP JSON-RPC.
 */

export interface MdnsService {
  instance: string;
  host: string;
  address: string;
  port: number;
}

export function encodeQuery(name: string, type = 12 /* PTR */): Buffer {
  const labels = name.replace(/\.$/, '').split('.');
  const parts: Buffer[] = [Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])]; // id 0, flags 0, 1 question
  for (const l of labels) {
    const b = Buffer.from(l, 'utf8');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0, (type >> 8) & 0xff, type & 0xff, 0, 1])); // root, QTYPE, QCLASS IN
  return Buffer.concat(parts);
}

function readName(buf: Buffer, offset: number, depth = 0): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      pos++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (depth > 10 || pos + 1 >= buf.length) throw new Error('bad name pointer');
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (next < 0) next = pos + 2;
      const r = readName(buf, ptr, depth + 1);
      labels.push(r.name);
      pos = -1;
      break;
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.filter(Boolean).join('.'), next: next >= 0 ? next : pos };
}

export interface DnsRecord {
  name: string;
  type: number;
  data: { ptr?: string; target?: string; port?: number; address?: string };
}

/** Parse the answer / authority / additional records of a DNS message. */
export function parseRecords(buf: Buffer): DnsRecord[] {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) pos = readName(buf, pos).next + 4;
  const out: DnsRecord[] = [];
  for (let i = 0; i < total && pos + 10 <= buf.length; i++) {
    const { name, next } = readName(buf, pos);
    pos = next;
    const type = buf.readUInt16BE(pos);
    const rdlen = buf.readUInt16BE(pos + 8);
    const rd = pos + 10;
    pos = rd + rdlen;
    if (pos > buf.length) break;
    const data: DnsRecord['data'] = {};
    if (type === 12) data.ptr = readName(buf, rd).name;
    else if (type === 33) {
      data.port = buf.readUInt16BE(rd + 4);
      data.target = readName(buf, rd + 6).name;
    } else if (type === 1 && rdlen === 4) data.address = [...buf.subarray(rd, rd + 4)].join('.');
    out.push({ name, type, data });
  }
  return out;
}

export function mdnsBrowse(service: string, timeoutMs = 2500): Promise<MdnsService[]> {
  return new Promise((resolve) => {
    const records: (DnsRecord & { from: string })[] = [];
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
      const ptrs = records.filter((r) => r.type === 12 && r.name.toLowerCase() === service.toLowerCase());
      const found = new Map<string, MdnsService>();
      for (const p of ptrs) {
        const srv = records.find((r) => r.type === 33 && r.name === p.data.ptr);
        if (!srv?.data.port) continue;
        const a = records.find((r) => r.type === 1 && r.name === srv.data.target)?.data.address ?? p.from;
        if (!isLanAddress(a)) continue;
        found.set(`${a}:${srv.data.port}`, { instance: (p.data.ptr ?? '').replace(`.${service}`, ''), host: srv.data.target ?? a, address: a, port: srv.data.port });
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(done, timeoutMs);
    s.on('error', () => done());
    s.on('message', (msg, rinfo) => {
      if (!isLanAddress(rinfo.address)) return;
      try {
        for (const r of parseRecords(msg)) records.push({ ...r, from: rinfo.address });
      } catch {
        /* malformed packet */
      }
    });
    s.bind(0, () => {
      const q = encodeQuery(service);
      const addr = process.env.MEDIAMAX_RENDERER_MDNS_ADDR ?? '224.0.0.251';
      const port = Number(process.env.MEDIAMAX_RENDERER_MDNS_PORT ?? 5353);
      s.send(q, port, addr);
      setTimeout(() => !finished && s.send(q, port, addr), 500);
    });
  });
}
