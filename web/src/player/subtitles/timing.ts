/**
 * Cue lookup by media time. Cues are sorted by start; overlapping cues (and cues that span many others) are found with
 * a running "max end" table so lookups stay O(log n + k) however long a cue lasts.
 */
export interface Timed {
  start: number;
  end: number;
}

export class CueIndex<T extends Timed> {
  readonly cues: T[];
  /** maxEnd[i] = max(cues[0..i].end) — lets the backwards scan stop early. */
  private readonly maxEnd: number[];

  constructor(cues: T[]) {
    this.cues = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
    this.maxEnd = [];
    let m = -Infinity;
    for (const c of this.cues) {
      m = Math.max(m, c.end);
      this.maxEnd.push(m);
    }
  }

  get length() {
    return this.cues.length;
  }

  /** Index of the last cue with start <= t, or -1. */
  private lastStartingBy(t: number): number {
    let lo = 0;
    let hi = this.cues.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].start <= t) {
        last = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return last;
  }

  /** Cues showing at time t (start <= t < end), in start order. */
  at(t: number): T[] {
    const out: T[] = [];
    for (let i = this.lastStartingBy(t); i >= 0; i--) {
      if (this.maxEnd[i] <= t) break;
      const c = this.cues[i];
      if (c.end > t) out.push(c);
    }
    return out.reverse();
  }

  /** Next time after t at which the active set changes (a cue starts or ends), or Infinity. */
  nextChange(t: number): number {
    let next = Infinity;
    const i = this.lastStartingBy(t);
    if (i + 1 < this.cues.length) next = this.cues[i + 1].start;
    for (const c of this.at(t)) if (c.end < next) next = c.end;
    return next;
  }
}

/**
 * Media time → subtitle time. `mediaMs` is the position in the file timeline (stream time + the stream's start offset);
 * a positive user delay shows subtitles later, so the subtitle clock runs behind by `delayMs`.
 */
export const subtitleClock = (mediaMs: number, delayMs: number) => mediaMs - delayMs;
