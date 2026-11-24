/** Colour helpers for server-provided CSS-ish colour strings. */
function parse(input: string): [number, number, number, number] | null {
  const s = input.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every((x) => !isNaN(x))) return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return null;
}

export function withAlpha(color: string, alpha: number): string {
  const c = parse(color);
  if (!c) return color;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, Math.min(1, alpha * c[3]))})`;
}

export function luminance(color: string): number {
  const c = parse(color);
  if (!c) return 0;
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

/** Mix two colours (t=0 -> a, t=1 -> b). */
export function mix(a: string, b: string, t: number): string {
  const ca = parse(a);
  const cb = parse(b);
  if (!ca || !cb) return a;
  const l = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${l(ca[0], cb[0])}, ${l(ca[1], cb[1])}, ${l(ca[2], cb[2])})`;
}

export function isValidColor(c: string | null | undefined): c is string {
  return !!c && parse(c) !== null;
}
