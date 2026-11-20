import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Security events in a stable, one-line format for fail2ban and CrowdSec (see deploy/):
 *
 *   2026-11-20T15:04:05.123Z mediamax[security] AUTH_FAIL ip=203.0.113.9 user="bob" reason=password
 *
 * Events: AUTH_FAIL (reason=password|pin|totp|api_key|subsonic), AUTH_LOCKED, AUTH_OK.
 * Written to <data>/logs/security.log (rotated at 10 MB) and mirrored to stdout so `docker logs` sources work too.
 */
const MAX = 10 * 1024 * 1024;
let file: string | null = null;

const clean = (v: string) => v.replace(/["\r\n\\]/g, '_').slice(0, 64);

export function securityEvent(event: 'AUTH_FAIL' | 'AUTH_LOCKED' | 'AUTH_OK', ip: string | null | undefined, fields: Record<string, string | number | undefined> = {}) {
  // Dual-stack sockets report IPv4 clients as ::ffff:a.b.c.d; log the plain address so ban tools see one identity.
  const addr = (ip || 'unknown').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  const parts = [`${new Date().toISOString()} mediamax[security] ${event} ip=${clean(addr)}`];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) parts.push(typeof v === 'number' ? `${k}=${v}` : /^[\w.@:-]+$/.test(v) && k !== 'user' ? `${k}=${v}` : `${k}="${clean(v)}"`);
  const line = parts.join(' ');
  // eslint-disable-next-line no-console
  if (event !== 'AUTH_OK') console.log(line);
  try {
    file ??= path.join(config.logDir, 'security.log');
    try {
      if (fs.statSync(file).size > MAX) fs.renameSync(file, `${file}.1`);
    } catch {
      /* not there yet */
    }
    fs.appendFileSync(file, line + '\n');
  } catch {
    /* logging must never break sign-in */
  }
}
