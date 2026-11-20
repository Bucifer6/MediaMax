/**
 * A minimal MQTT 3.1.1 client (CONNECT with last will, PUBLISH QoS 0/1, SUBSCRIBE, keep-alive, TLS).
 * Enough for Home Assistant discovery and command buttons without pulling a dependency tree into the server.
 * Reconnecting is the caller's job: listen for `close`.
 */
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

export interface MqttWill { topic: string; payload: string; retain?: boolean; qos?: 0 | 1 }

export interface MqttOptions {
  /** mqtt://host[:1883] or mqtts://host[:8883] (also tcp:// / ssl://). */
  url: string;
  clientId: string;
  username?: string | null;
  password?: string | null;
  /** Seconds (default 60). */
  keepalive?: number;
  will?: MqttWill;
  /** Force TLS on an mqtt:// URL. */
  tls?: boolean;
  /** Verify the broker certificate (default true). */
  rejectUnauthorized?: boolean;
  connectTimeoutMs?: number;
}

const CONNACK_ERRORS: Record<number, string> = {
  1: 'unacceptable protocol version',
  2: 'client id rejected',
  3: 'broker unavailable',
  4: 'bad username or password',
  5: 'not authorised',
};

/* ----------------------------- encoding ----------------------------- */

function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

const str = (s: string | Buffer) => {
  const b = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};

export function packet(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), varint(body.length), body]);
}

export function encodeConnect(o: MqttOptions): Buffer {
  let flags = 0x02; // clean session
  const payload: Buffer[] = [str(o.clientId)];
  if (o.will) {
    flags |= 0x04 | ((o.will.qos ?? 0) << 3) | (o.will.retain ? 0x20 : 0);
    payload.push(str(o.will.topic), str(o.will.payload));
  }
  if (o.username) {
    flags |= 0x80;
    payload.push(str(o.username));
    if (o.password) {
      flags |= 0x40;
      payload.push(str(o.password));
    }
  }
  const header = Buffer.concat([str('MQTT'), Buffer.from([4, flags]), u16(o.keepalive ?? 60)]);
  return packet(1, 0, Buffer.concat([header, ...payload]));
}

export function encodePublish(topic: string, payload: string | Buffer, opts: { qos?: 0 | 1; retain?: boolean; id?: number } = {}): Buffer {
  const qos = opts.qos ?? 0;
  const parts: Uint8Array[] = [str(topic)];
  if (qos > 0) parts.push(u16(opts.id ?? 1));
  parts.push(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload);
  return packet(3, (qos << 1) | (opts.retain ? 1 : 0), Buffer.concat(parts));
}

/** Split a byte stream into complete MQTT packets; returns the packets and any leftover bytes. */
export function readPackets(buf: Buffer): { packets: { type: number; flags: number; body: Buffer }[]; rest: Buffer } {
  const packets: { type: number; flags: number; body: Buffer }[] = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    let mult = 1;
    let len = 0;
    let i = off + 1;
    let complete = false;
    for (let k = 0; k < 4 && i < buf.length; k++, i++) {
      len += (buf[i] & 0x7f) * mult;
      mult *= 128;
      if ((buf[i] & 0x80) === 0) {
        complete = true;
        i++;
        break;
      }
    }
    if (!complete || i + len > buf.length) break;
    packets.push({ type: buf[off] >> 4, flags: buf[off] & 0x0f, body: buf.subarray(i, i + len) });
    off = i + len;
  }
  return { packets, rest: buf.subarray(off) };
}

/* ------------------------------ client ------------------------------ */

export class MqttClient extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPingResp = Date.now();
  connected = false;

  constructor(private readonly opts: MqttOptions) {
    super();
  }

  private target() {
    const u = new URL(this.opts.url);
    const secure = this.opts.tls || u.protocol === 'mqtts:' || u.protocol === 'ssl:' || u.protocol === 'tls:';
    if (!['mqtt:', 'mqtts:', 'tcp:', 'ssl:', 'tls:'].includes(u.protocol)) throw new Error(`Unsupported broker URL scheme ${u.protocol} (use mqtt:// or mqtts://)`);
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (secure ? 8883 : 1883), secure };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let t: ReturnType<MqttClient['target']>;
      try {
        t = this.target();
      } catch (e) {
        return reject(e);
      }
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.destroy();
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error('Timed out connecting to the MQTT broker')), this.opts.connectTimeoutMs ?? 10000);
      const onConnect = () => this.sock!.write(encodeConnect(this.opts));
      const sock = t.secure
        ? tls.connect({ host: t.host, port: t.port, servername: net.isIP(t.host) ? undefined : t.host, rejectUnauthorized: this.opts.rejectUnauthorized !== false }, onConnect)
        : net.connect({ host: t.host, port: t.port }, onConnect);
      this.sock = sock;
      sock.setNoDelay(true);
      sock.on('data', (d) => {
        const chunk = typeof d === 'string' ? Buffer.from(d) : d;
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        const { packets, rest } = readPackets(this.buf);
        this.buf = Buffer.from(rest);
        for (const p of packets) {
          if (p.type === 2 && !settled) {
            const rc = p.body[1];
            if (rc !== 0) return fail(new Error(`Broker refused the connection: ${CONNACK_ERRORS[rc] ?? `code ${rc}`}`));
            settled = true;
            clearTimeout(timer);
            this.connected = true;
            this.startPing();
            resolve();
          } else this.handle(p);
        }
      });
      sock.on('error', (e) => {
        if (!settled) fail(e);
        else this.emit('error', e);
      });
      sock.on('close', () => {
        const was = this.connected;
        this.cleanup(new Error('Connection closed'));
        if (!settled) fail(new Error('Connection closed by the broker'));
        else if (was) this.emit('close');
      });
    });
  }

  private handle(p: { type: number; flags: number; body: Buffer }) {
    switch (p.type) {
      case 3: { // PUBLISH from broker
        const tlen = p.body.readUInt16BE(0);
        const topic = p.body.subarray(2, 2 + tlen).toString('utf8');
        const qos = (p.flags >> 1) & 3;
        let off = 2 + tlen;
        if (qos > 0) {
          const id = p.body.readUInt16BE(off);
          off += 2;
          this.sock?.write(packet(4, 0, u16(id)));
        }
        this.emit('message', topic, Buffer.from(p.body.subarray(off)));
        break;
      }
      case 4: // PUBACK
      case 9: { // SUBACK
        const id = p.body.readUInt16BE(0);
        const w = this.pending.get(id);
        if (w) {
          this.pending.delete(id);
          w.resolve(p.type === 9 ? [...p.body.subarray(2)] : undefined);
        }
        break;
      }
      case 13: // PINGRESP
        this.lastPingResp = Date.now();
        break;
    }
  }

  private startPing() {
    const ka = (this.opts.keepalive ?? 60) * 1000;
    if (!ka) return;
    this.lastPingResp = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPingResp > ka * 2) {
        this.emit('error', new Error('Broker stopped answering keep-alive pings'));
        this.sock?.destroy();
        return;
      }
      this.sock?.write(Buffer.from([0xc0, 0x00]));
    }, Math.max(1000, Math.floor(ka * 0.75)));
    this.pingTimer.unref();
  }

  private id(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
    return id;
  }

  private waitFor<T>(id: number, ms = 10000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Timed out waiting for the broker'));
      }, ms);
      t.unref();
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }

  publish(topic: string, payload: string | Buffer, opts: { qos?: 0 | 1; retain?: boolean } = {}): Promise<void> {
    if (!this.sock || !this.connected) return Promise.reject(new Error('Not connected'));
    const qos = opts.qos ?? 0;
    if (qos === 0) {
      this.sock.write(encodePublish(topic, payload, opts));
      return Promise.resolve();
    }
    const id = this.id();
    const p = this.waitFor<void>(id);
    this.sock.write(encodePublish(topic, payload, { ...opts, id }));
    return p;
  }

  subscribe(topics: string[], qos: 0 | 1 = 0): Promise<number[]> {
    if (!this.sock || !this.connected) return Promise.reject(new Error('Not connected'));
    const id = this.id();
    const p = this.waitFor<number[]>(id);
    this.sock.write(packet(8, 2, Buffer.concat([u16(id), ...topics.map((t) => Buffer.concat([str(t), Buffer.from([qos])]))])));
    return p;
  }

  /** Clean disconnect (the broker does NOT publish the last will). */
  async end(): Promise<void> {
    if (this.sock && this.connected) {
      const s = this.sock;
      this.connected = false;
      await new Promise<void>((r) => s.end(Buffer.from([0xe0, 0x00]), () => r()));
    }
    this.destroy();
  }

  destroy() {
    this.cleanup(new Error('Connection closed'));
    this.sock?.destroy();
    this.sock = null;
  }

  private cleanup(err: Error) {
    this.connected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const w of this.pending.values()) w.reject(err);
    this.pending.clear();
  }
}
