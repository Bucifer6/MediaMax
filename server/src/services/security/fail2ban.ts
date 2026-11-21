import net from 'node:net';
import { decode, encodeCommand, type PyValue } from './pickle.js';

const END = Buffer.from('<F2B_END_COMMAND>');

/** Send one command to fail2ban's control socket (or the Kinora bridge) and return its reply. */
export function f2bCommand(socketPath: string, args: string[], timeoutMs = 5000): Promise<PyValue> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('fail2ban did not answer in time'));
    }, timeoutMs);
    sock.on('connect', () => sock.write(Buffer.concat([encodeCommand(args), END])));
    sock.on('data', (c: Buffer) => {
      chunks.push(c);
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        sock.destroy();
        reject(new Error('fail2ban reply too large'));
        return;
      }
      const all = Buffer.concat(chunks);
      const at = all.indexOf(END);
      if (at >= 0) {
        clearTimeout(timer);
        sock.end();
        try {
          const reply = decode(all.subarray(0, at));
          // fail2ban answers [code, value]; code 0 = OK. Errors may come back as a plain string.
          if (typeof reply === 'string' && reply.startsWith('ERROR')) return reject(new Error(reply));
          if (Array.isArray(reply) && reply.length === 2 && typeof reply[0] === 'number') {
            if (reply[0] !== 0) return reject(new Error(String(reply[1])));
            return resolve(reply[1]);
          }
          resolve(reply);
        } catch (e) {
          // fail2ban reports errors as pickled exception objects, which we deliberately don't unpickle.
          const m = /refusing fail2ban\.exceptions\.(\w+)/.exec((e as Error).message);
          reject(m ? new Error(m[1] === 'UnknownJailException' ? `Unknown jail "${args[1] ?? ''}"` : `fail2ban error: ${m[1]}`) : e);
        }
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** fail2ban replies with lists of [name, value] pairs; turn them into an object (recursively). */
function pairs(v: PyValue): Record<string, PyValue> {
  const out: Record<string, PyValue> = {};
  if (Array.isArray(v)) for (const p of v) if (Array.isArray(p) && p.length === 2 && typeof p[0] === 'string') out[p[0]] = Array.isArray(p[1]) && p[1].every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string') ? (pairs(p[1]) as PyValue) : p[1];
  return out;
}

export interface F2bJail { name: string; currentlyFailed: number; totalFailed: number; currentlyBanned: number; totalBanned: number; bannedIps: string[] }

export async function f2bStatus(socketPath: string): Promise<{ jails: F2bJail[] }> {
  const top = pairs(await f2bCommand(socketPath, ['status']));
  const names = String(top['Jail list'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const jails: F2bJail[] = [];
  for (const name of names) {
    const st = pairs(await f2bCommand(socketPath, ['status', name]));
    const f = (st.Filter ?? {}) as Record<string, PyValue>;
    const a = (st.Actions ?? {}) as Record<string, PyValue>;
    const ips = a['Banned IP list'];
    jails.push({
      name, currentlyFailed: Number(f['Currently failed'] ?? 0), totalFailed: Number(f['Total failed'] ?? 0),
      currentlyBanned: Number(a['Currently banned'] ?? 0), totalBanned: Number(a['Total banned'] ?? 0),
      bannedIps: Array.isArray(ips) ? ips.map(String) : typeof ips === 'string' && ips ? ips.split(/\s+/) : [],
    });
  }
  return { jails };
}

export const f2bBan = (socketPath: string, jail: string, ip: string) => f2bCommand(socketPath, ['set', jail, 'banip', ip]);
export const f2bUnban = (socketPath: string, jail: string, ip: string) => f2bCommand(socketPath, ['set', jail, 'unbanip', ip]);
