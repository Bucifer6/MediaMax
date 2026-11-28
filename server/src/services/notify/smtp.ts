/**
 * Minimal SMTP client for notification emails: implicit TLS (465) or plain + STARTTLS, AUTH PLAIN/LOGIN, one message.
 */
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

export interface SmtpConfig {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  /** Accept self-signed certificates. */
  insecure?: boolean;
  timeoutMs?: number;
}
export interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const addr = (s: string) => s.match(/<([^>]+)>/)?.[1] ?? s.trim();

export function buildMessage(m: Mail, date = new Date()): string {
  const body = Buffer.from(m.text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  return [
    `From: ${m.from}`, `To: ${m.to.join(', ')}`, `Subject: ${encWord(m.subject)}`, `Date: ${date.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${addr(m.from).split('@')[1] ?? 'vibe'}>`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body, '',
  ].join('\r\n');
}

export async function sendMail(cfg: SmtpConfig, m: Mail): Promise<void> {
  if (!cfg.host) throw new Error('SMTP host is not set');
  const timeout = cfg.timeoutMs ?? 15000;
  let sock: net.Socket = cfg.port === 465
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: !cfg.insecure })
    : net.connect({ host: cfg.host, port: cfg.port });
  sock.setTimeout(timeout);
  let buf = '';
  let waiter: ((line: string) => void) | null = null;
  let rejecter: ((e: Error) => void) | null = null;
  let failed: Error | null = null;
  const onData = (d: Buffer) => {
    buf += d.toString('utf8');
    // A complete reply ends with a line "NNN text" (no dash after the code).
    const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
    if (m && waiter) {
      const reply = buf;
      buf = '';
      const w = waiter;
      waiter = null;
      w(reply);
    }
  };
  const attach = (s: net.Socket) => {
    s.on('data', onData);
    s.on('error', (e) => {
      failed = e;
      rejecter?.(e);
    });
    s.on('timeout', () => {
      failed = new Error('SMTP timeout');
      s.destroy();
    });
    s.on('close', () => rejecter?.(failed ?? new Error('SMTP connection closed')));
  };
  attach(sock);
  const read = () => new Promise<string>((resolve, reject) => {
    if (failed) return reject(failed);
    const t = setTimeout(() => reject(failed ?? new Error('SMTP timeout')), timeout);
    waiter = (r) => {
      clearTimeout(t);
      rejecter = null;
      resolve(r);
    };
    rejecter = (e) => {
      clearTimeout(t);
      rejecter = null;
      waiter = null;
      reject(e);
    };
  });
  const cmd = async (line: string | null, ok: number[]) => {
    const p = read();
    if (line !== null) sock.write(line + '\r\n');
    const reply = await p;
    const code = Number(reply.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/)?.[1]);
    if (!ok.includes(code)) throw new Error(`SMTP ${line?.split(' ')[0] ?? 'greeting'}: ${reply.trim().split('\r\n').pop()}`);
    return reply;
  };
  try {
    await cmd(null, [220]);
    const name = os.hostname() || 'vibe';
    let ehlo = await cmd(`EHLO ${name}`, [250]);
    if (!(sock instanceof tls.TLSSocket) && /STARTTLS/i.test(ehlo)) {
      await cmd('STARTTLS', [220]);
      sock.removeAllListeners('data');
      sock.removeAllListeners('close');
      sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const t = tls.connect({ socket: sock, servername: cfg.host, rejectUnauthorized: !cfg.insecure }, () => resolve(t));
        t.once('error', reject);
      });
      attach(sock);
      ehlo = await cmd(`EHLO ${name}`, [250]);
    }
    if (cfg.username) {
      if (/AUTH[ =][^\r\n]*PLAIN/i.test(ehlo)) {
        await cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.username}\0${cfg.password ?? ''}`).toString('base64')}`, [235]);
      } else {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(cfg.username).toString('base64'), [334]);
        await cmd(Buffer.from(cfg.password ?? '').toString('base64'), [235]);
      }
    }
    await cmd(`MAIL FROM:<${addr(m.from)}>`, [250]);
    for (const to of m.to) await cmd(`RCPT TO:<${addr(to)}>`, [250, 251]);
    await cmd('DATA', [354]);
    // Dot-stuffing: lines starting with "." get an extra one.
    await cmd(buildMessage(m).replace(/\r\n\./g, '\r\n..') + '\r\n.', [250]);
    await cmd('QUIT', [221]).catch(() => undefined);
  } finally {
    sock.destroy();
  }
}
