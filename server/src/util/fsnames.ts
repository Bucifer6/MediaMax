import { isUtf8 } from 'node:buffer';

/**
 * File names on Linux are raw bytes. Names copied from old Windows/Samba shares in a legacy codepage (cp1252, cp437,
 * Shift-JIS…) are not valid UTF-8; Node decodes them lossily (U+FFFD), so the decoded path no longer exists on disk and
 * breaks URLs and subtitle matching. Detect them from the raw bytes (strict: overlong forms and surrogates are invalid).
 */
export const isValidUtf8Name = (name: Buffer): boolean => isUtf8(name);

function seqLen(b: number): number {
  if (b < 0x80) return 1;
  if (b >= 0xc2 && b <= 0xdf) return 2;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return 0;
}

/** A printable, log-safe rendering of a raw name: valid UTF-8 is kept, invalid bytes and control characters become \xNN. */
export function displayName(name: Buffer): string {
  let out = '';
  let i = 0;
  while (i < name.length) {
    const b = name[i];
    const n = seqLen(b);
    if (n === 1) {
      out += b < 0x20 || b === 0x7f ? `\\x${b.toString(16).padStart(2, '0')}` : String.fromCharCode(b);
      i++;
    } else if (n && i + n <= name.length && isUtf8(name.subarray(i, i + n))) {
      out += name.subarray(i, i + n).toString('utf8');
      i += n;
    } else {
      out += `\\x${b.toString(16).padStart(2, '0')}`;
      i++;
    }
  }
  return out;
}
