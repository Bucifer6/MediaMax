import type { HomeRow } from '@mediamax/shared';

/** Rows that belong to "what am I watching": they lead Home unless the profile arranged its own order. */
const LEAD: string[] = ['continue', 'nextup', 'library-recent'];

/**
 * Library first: Continue Watching, then Next Up, then Recently Added per library, then the server's other rows in
 * their configured order. A profile that saved its own order (Customize Home) gets exactly that order (the server
 * already applied it).
 */
export function orderHomeRows<T extends Pick<HomeRow, 'type'>>(rows: T[], customOrder: boolean): T[] {
  if (customOrder) return rows;
  const rank = (r: T) => {
    const i = LEAD.indexOf(r.type);
    return i < 0 ? LEAD.length : i;
  };
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}
