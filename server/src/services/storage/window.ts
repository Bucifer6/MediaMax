/** Maintenance-window maths (server local time). Pure functions, unit tested. */

/** "HH:MM" → minutes after midnight, or null when malformed. */
export function parseHm(v: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `date` inside the daily window [start, end)? Windows may wrap midnight (23:00–04:00).
 * start === end means "all day" (no restriction).
 */
export function inWindow(date: Date, start: string, end: string): boolean {
  const s = parseHm(start);
  const e = parseHm(end);
  if (s == null || e == null || s === e) return true;
  const now = date.getHours() * 60 + date.getMinutes();
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** The next moment the window opens (now if it's open already). */
export function nextWindowStart(date: Date, start: string, end: string): Date {
  if (inWindow(date, start, end)) return new Date(date);
  const s = parseHm(start)!;
  const next = new Date(date);
  next.setSeconds(0, 0);
  next.setHours(Math.floor(s / 60), s % 60);
  if (next.getTime() <= date.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** Minutes the window stays open per day (for the admin UI hint). */
export function windowLength(start: string, end: string): number {
  const s = parseHm(start);
  const e = parseHm(end);
  if (s == null || e == null || s === e) return 24 * 60;
  return s < e ? e - s : 24 * 60 - s + e;
}
