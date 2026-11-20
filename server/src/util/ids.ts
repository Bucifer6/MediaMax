import crypto from 'node:crypto';

export const newId = (): string => crypto.randomBytes(12).toString('base64url');
export const newToken = (): string => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
/** Stable id derived from a key (used so rescans keep the same item ids). */
export const stableId = (...parts: (string | number | null | undefined)[]): string =>
  crypto.createHash('sha1').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('base64url').slice(0, 16);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function shortCode(len = 4): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}
