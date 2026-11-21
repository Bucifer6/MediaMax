/**
 * Instant play: the bookkeeping behind POST /playback/:itemId/prepare.
 *
 * Clients call prepare when the user is about to press Play (Play button hovered or focused, item page opened, the
 * next episode's "Up next" card shown). The server then
 *   1. runs the playback decision now and caches it (PlanCache, per user + device + item + request, short TTL), and
 *   2. for remux / transcode, starts the job early in a pending slot (WarmSlots): ffmpeg produces the first segments
 *      while no session exists, so nothing is recorded in history, no stream limit is used and nobody sees a session.
 * startPlayback (playback.ts) then reuses the cached decision and adopts a matching warm job instantly.
 *
 * Both classes are generic over what they hold, take an injectable clock and know nothing about ffmpeg, so they are
 * unit-tested with fakes (test/instant-play.test.ts). The wiring lives in playback.ts (preparePlayback, startPlayback).
 *
 * Caps (WarmSlots): one warm job per device (a new prepare on the device replaces the old one), `maxJobs` server-wide,
 * an unused job is stopped after `ttlMs`, and callers check the transcoder budget before warming (see canWarm).
 */

/** What a warm slot needs from a job: TranscodeJob / RenditionManager in production, a fake in tests. */
export interface WarmJobHandle {
  stop(): void;
  /** The job died (ffmpeg failed / exited without output): not worth adopting. */
  dead?(): boolean;
}

export interface WarmEntry<J extends WarmJobHandle = WarmJobHandle> {
  /** Plan key (user + device + item + request), see playbackPlanKey in playback.ts. */
  key: string;
  device: string;
  userId: string;
  /** Account the user belongs to (itself, or the owner of a profile). */
  ownerId?: string;
  itemId: string;
  /** 'transcode' entries count against the transcoder budget. */
  kind: 'remux' | 'transcode';
  job: J;
  createdAt: number;
  expiresAt: number;
  /** Segment the job was started at (resume position), for adoption decisions. */
  startSegment: number;
}

export interface WarmSlotOptions {
  maxJobs: number;
  ttlMs: number;
  now?: () => number;
  /** Timers are injectable so tests can drive expiry; defaults to setTimeout with unref. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  onEvent?: (ev: 'expired' | 'replaced' | 'adopted' | 'reclaimed' | 'dropped', e: WarmEntry) => void;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

export class WarmSlots<J extends WarmJobHandle = WarmJobHandle> {
  private readonly byDevice = new Map<string, { entry: WarmEntry<J>; timer: { cancel(): void } }>();

  constructor(private readonly o: WarmSlotOptions) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  get size() {
    return this.byDevice.size;
  }

  entries(): WarmEntry<J>[] {
    return [...this.byDevice.values()].map((x) => x.entry);
  }

  transcodeCount() {
    return this.entries().filter((e) => e.kind === 'transcode').length;
  }

  /** The device's warm entry, if it is for `key` and still usable. */
  peek(device: string, key: string): WarmEntry<J> | null {
    const slot = this.byDevice.get(device);
    if (!slot || slot.entry.key !== key || slot.entry.job.dead?.() || slot.entry.expiresAt <= this.now()) return null;
    return slot.entry;
  }

  /** Room for one more warm job (a device's own slot is reused, so it never counts against itself). */
  hasRoom(device: string): boolean {
    return this.byDevice.has(device) || this.byDevice.size < this.o.maxJobs;
  }

  /**
   * Hold `job` for `device`. Replaces (stops) whatever the device held before. Returns false (and the caller should
   * stop the job) when the server-wide cap is reached.
   */
  put(entry: Omit<WarmEntry<J>, 'createdAt' | 'expiresAt'>): WarmEntry<J> | null {
    if (!this.hasRoom(entry.device)) return null;
    this.drop(entry.device, 'replaced');
    const now = this.now();
    const e: WarmEntry<J> = { ...entry, createdAt: now, expiresAt: now + this.o.ttlMs };
    const timer = (this.o.schedule ?? defaultSchedule)(() => this.expire(entry.device, e), this.o.ttlMs);
    this.byDevice.set(entry.device, { entry: e, timer });
    return e;
  }

  /** Keep the device's matching entry alive for another `ttlMs` (the user is still hovering / on the page). */
  refresh(device: string, key: string): WarmEntry<J> | null {
    const slot = this.byDevice.get(device);
    const e = this.peek(device, key);
    if (!slot || !e) return null;
    slot.timer.cancel();
    e.expiresAt = this.now() + this.o.ttlMs;
    slot.timer = (this.o.schedule ?? defaultSchedule)(() => this.expire(device, e), this.o.ttlMs);
    return e;
  }

  /**
   * Playback is starting on `device`: hand over the entry for `key` (the caller now owns the job). Any other warm job
   * of the device is stopped — the user chose something else.
   */
  take(device: string, key: string): WarmEntry<J> | null {
    const slot = this.byDevice.get(device);
    if (!slot) return null;
    const usable = this.peek(device, key);
    if (!usable) {
      this.drop(device, 'dropped');
      return null;
    }
    slot.timer.cancel();
    this.byDevice.delete(device);
    this.o.onEvent?.('adopted', usable);
    return usable;
  }

  /** Stop and forget the device's warm job. */
  drop(device: string, why: 'replaced' | 'dropped' | 'reclaimed' = 'dropped') {
    const slot = this.byDevice.get(device);
    if (!slot) return;
    slot.timer.cancel();
    this.byDevice.delete(device);
    slot.entry.job.stop();
    this.o.onEvent?.(why, slot.entry);
  }

  private expire(device: string, e: WarmEntry<J>) {
    const slot = this.byDevice.get(device);
    if (!slot || slot.entry !== e) return;
    this.byDevice.delete(device);
    e.job.stop();
    this.o.onEvent?.('expired', e);
  }

  /**
   * Free transcoder capacity for real playback: stop warm transcodes (oldest first, never `exceptDevice`'s) until
   * `busy` (encoders running once the new one has started) + warm transcodes is at most `max`. Returns how many were stopped.
   */
  reclaim(busy: number, max: number, exceptDevice?: string): number {
    let n = 0;
    const victims = this.entries().filter((e) => e.kind === 'transcode' && e.device !== exceptDevice).sort((a, b) => a.createdAt - b.createdAt);
    while (victims.length && busy + this.transcodeCount() > max) {
      this.drop(victims.shift()!.device, 'reclaimed');
      n++;
    }
    return n;
  }

  /** Stop warm jobs of a user (account deleted / signed out everywhere), or all of them (shutdown). */
  clear(filter?: (e: WarmEntry<J>) => boolean) {
    for (const e of this.entries()) if (!filter || filter(e)) this.drop(e.device, 'dropped');
  }
}

/**
 * May a warm job of `kind` start now? Remuxes only need a free warm slot; a transcode also needs the transcoder to be
 * idle enough that real playback (running transcodes) plus every warm transcode stays below the concurrency limit.
 */
export function canWarm(kind: 'remux' | 'transcode', s: { runningTranscodes: number; warmTranscodes: number; maxConcurrent: number; slotFree: boolean }): { ok: boolean; reason?: 'busy' | 'capacity' } {
  if (!s.slotFree) return { ok: false, reason: 'capacity' };
  if (kind === 'transcode' && s.runningTranscodes + s.warmTranscodes + 1 > s.maxConcurrent) return { ok: false, reason: 'busy' };
  return { ok: true };
}

/* ------------------------------ plan cache ------------------------------ */

export interface PlanCacheOptions<P> {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
  /** Still valid? (settings unchanged, media file not rescanned …). Checked on every get. */
  validate?: (p: P) => boolean;
}

/** Small TTL + LRU cache of playback decisions, keyed by the plan key. */
export class PlanCache<P> {
  private readonly map = new Map<string, { plan: P; at: number }>();

  constructor(private readonly o: PlanCacheOptions<P>) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  get size() {
    return this.map.size;
  }

  get(key: string): P | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.o.ttlMs || (this.o.validate && !this.o.validate(hit.plan))) {
      this.map.delete(key);
      return null;
    }
    // LRU: move to the end.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.plan;
  }

  set(key: string, plan: P) {
    this.map.delete(key);
    this.map.set(key, { plan, at: this.now() });
    while (this.map.size > this.o.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  /** Forget plans matching `pred` (e.g. an item's plans after its media changed), or everything. */
  invalidate(pred?: (p: P, key: string) => boolean): number {
    let n = 0;
    for (const [k, v] of [...this.map]) {
      if (!pred || pred(v.plan, k)) {
        this.map.delete(k);
        n++;
      }
    }
    return n;
  }
}

/** log1.25 bucket of a measured bandwidth, so prepare and start (a second apart) share a key despite jitter. */
export function bandwidthBucket(kbps: number | null | undefined): number | null {
  if (!kbps || !(kbps > 0)) return null;
  return Math.round(Math.log(kbps) / Math.log(1.25));
}

/** JSON with sorted object keys: equal requests give equal strings whatever the property order. */
export function stableJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}
