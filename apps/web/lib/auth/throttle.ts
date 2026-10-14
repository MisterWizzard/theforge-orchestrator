/**
 * In-process failure throttle for the login route (ADR-027).
 *
 * Per source (the client address as the login route sees it): after
 * `FAILURE_THRESHOLD` wrong passwords the source is locked for `LOCKOUT_MS`,
 * and the count starts again from zero when the lock lapses. Across all
 * sources: `GLOBAL_FAILURE_THRESHOLD` failures inside one idle window lock
 * everyone for `LOCKOUT_MS`, which is what stops a client that rotates
 * `x-forwarded-for` from turning the per-source rule into no rule at all.
 * A success clears that source and only that source.
 *
 * In memory on purpose: one web process, one operator. A restart forgets the
 * counts, which is the documented limit, and the 300 ms `FAILURE_DELAY_MS` the
 * route adds on every failure applies regardless of the counts.
 */
export const FAILURE_THRESHOLD = 5;
export const GLOBAL_FAILURE_THRESHOLD = 50;
export const LOCKOUT_MS = 60_000;
export const FAILURE_DELAY_MS = 300;
/** A source with no failure for this long, and no live lock, is forgotten; the global count restarts too. */
export const IDLE_MS = 10 * 60_000;
export const GLOBAL_KEY = '*';

type Entry = { failures: number; lockedUntil: number; lastFailureAt: number };

export type ThrottleOptions = {
  threshold?: number;
  globalThreshold?: number;
  lockoutMs?: number;
  idleMs?: number;
};

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly threshold: number;
  private readonly globalThreshold: number;
  private readonly lockoutMs: number;
  private readonly idleMs: number;

  constructor(options: ThrottleOptions = {}) {
    this.threshold = options.threshold ?? FAILURE_THRESHOLD;
    this.globalThreshold = options.globalThreshold ?? GLOBAL_FAILURE_THRESHOLD;
    this.lockoutMs = options.lockoutMs ?? LOCKOUT_MS;
    this.idleMs = options.idleMs ?? IDLE_MS;
  }

  /** Milliseconds until `source` may try again, whichever of its own lock or the global lock lasts longer; 0 when free. */
  lockedFor(source: string, now = Date.now()): number {
    return Math.max(this.remaining(source, now), this.remaining(GLOBAL_KEY, now));
  }

  recordFailure(source: string, now = Date.now()): { failures: number; lockedFor: number } {
    this.prune(now);
    const entry = this.bump(source, this.threshold, now);
    this.bump(GLOBAL_KEY, this.globalThreshold, now);
    return { failures: entry.failures, lockedFor: this.lockedFor(source, now) };
  }

  /** A correct password forgets this source's failures; the global count is untouched. */
  reset(source: string): void {
    this.entries.delete(source);
  }

  /** Sources currently remembered (tests). */
  get size(): number {
    return this.entries.size;
  }

  private remaining(key: string, now: number): number {
    const entry = this.entries.get(key);
    return entry && entry.lockedUntil > now ? entry.lockedUntil - now : 0;
  }

  private bump(key: string, threshold: number, now: number): Entry {
    const entry = this.entries.get(key) ?? { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
    // A lapsed lock or a long silence starts the count again.
    if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) {
      entry.failures = 0;
      entry.lockedUntil = 0;
    } else if (entry.lastFailureAt !== 0 && now - entry.lastFailureAt > this.idleMs) {
      entry.failures = 0;
    }
    entry.failures += 1;
    entry.lastFailureAt = now;
    if (entry.failures >= threshold) {
      entry.lockedUntil = now + this.lockoutMs;
      entry.failures = 0;
    }
    this.entries.set(key, entry);
    return entry;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= now && now - entry.lastFailureAt > this.idleMs) {
        this.entries.delete(key);
      }
    }
  }
}
