/**
 * Postponed background jobs, tracked per disk. A scheduled task that was due outside the maintenance window (or
 * whose disk was asleep) is "deferred"; when a disk wakes anyway — someone streams from it — that disk's share of
 * every deferred task is run, and the disk is marked done for those tasks. A full run in the window clears the task.
 */
export interface DeferredEntry { taskId: string; since: number; doneDisks: Set<string> }

export class PiggybackQueue {
  private entries = new Map<string, DeferredEntry>();

  /** Mark a task as postponed (keeps the original "since" and progress if already deferred). */
  defer(taskId: string, now = Date.now()) {
    if (!this.entries.has(taskId)) this.entries.set(taskId, { taskId, since: now, doneDisks: new Set() });
  }

  isDeferred(taskId: string) {
    return this.entries.has(taskId);
  }

  /** Tasks with work left on `disk`, oldest first. */
  pendingFor(disk: string): string[] {
    return [...this.entries.values()].filter((e) => !e.doneDisks.has(disk)).sort((a, b) => a.since - b.since).map((e) => e.taskId);
  }

  /** `disk`'s part of `taskId` is done. When every known disk is done the task leaves the queue. */
  markDone(taskId: string, disk: string, allDisks?: Iterable<string>) {
    const e = this.entries.get(taskId);
    if (!e) return;
    e.doneDisks.add(disk);
    if (allDisks) {
      const all = [...allDisks];
      if (all.length && all.every((d) => e.doneDisks.has(d))) this.entries.delete(taskId);
    }
  }

  /** The task ran in full (maintenance window or manual run). */
  clear(taskId: string) {
    this.entries.delete(taskId);
  }

  snapshot(): { taskId: string; since: number; doneDisks: string[] }[] {
    return [...this.entries.values()].map((e) => ({ taskId: e.taskId, since: e.since, doneDisks: [...e.doneDisks] }));
  }

  restore(list: { taskId: string; since: number; doneDisks: string[] }[]) {
    this.entries.clear();
    for (const e of list ?? []) if (e && typeof e.taskId === 'string') this.entries.set(e.taskId, { taskId: e.taskId, since: Number(e.since) || Date.now(), doneDisks: new Set(e.doneDisks ?? []) });
  }

  get size() {
    return this.entries.size;
  }
}
