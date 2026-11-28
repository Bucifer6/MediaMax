export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * One byte range, RFC 9110 §14. Invalid/unsupported ranges are ignored (200), never partially parsed.
 * Multipart requests are deliberately ignored until we can send multipart/byteranges correctly.
 */
export function byteRange(header: string | undefined, size: number): ByteRange {
  if (!header || !Number.isSafeInteger(size) || size < 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  // Compare as integers before converting to file offsets: a client can send arbitrarily large numerals.
  const length = BigInt(size);
  if (!m[1]) {
    const suffix = BigInt(m[2]);
    if (!suffix || !length) return 'unsatisfiable';
    return { start: Number(suffix >= length ? 0n : length - suffix), end: size - 1 };
  }
  const start = BigInt(m[1]);
  const end = m[2] ? BigInt(m[2]) : length - 1n;
  if (m[2] && end < start) return null;
  if (start >= length) return 'unsatisfiable';
  return { start: Number(start), end: Number(end >= length ? length - 1n : end) };
}
