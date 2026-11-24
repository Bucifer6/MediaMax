/** Shared bits of the sign-in failure lockouts (services/auth, services/profiles, routes/auth, routes/subsonic). */
export type Failure = { n: number; until: number };

/** Failure maps are keyed by unauthenticated input (usernames, IPs): past this size, expired entries are dropped. */
export const SWEEP_AT = 10_000;

/**
 * Drop expired entries once the map is larger than `max`. An entry whose window has passed (`until < now`) behaves
 * exactly like a missing one (not locked, the next failure starts a new window), so this never changes a lockout.
 */
export function sweepExpired(map: Map<string, Failure>, max = SWEEP_AT) {
  if (map.size <= max) return;
  const now = Date.now();
  for (const [k, f] of map) if (f.until < now) map.delete(k);
}

/**
 * Attempts whose (async) secret check is still running, per key. Lockout checks add these to the recorded failures,
 * so a burst of concurrent guesses can't all slip past the limit while their hashes are computed off-thread.
 */
export class Pending {
  private m = new Map<string, number>();
  count(key: string) {
    return this.m.get(key) ?? 0;
  }
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.m.set(key, this.count(key) + 1);
    try {
      return await fn();
    } finally {
      const n = this.count(key) - 1;
      if (n > 0) this.m.set(key, n);
      else this.m.delete(key);
    }
  }
}
