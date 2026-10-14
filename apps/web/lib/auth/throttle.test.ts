import { describe, expect, it } from 'vitest';
import {
  FAILURE_THRESHOLD,
  GLOBAL_FAILURE_THRESHOLD,
  IDLE_MS,
  LOCKOUT_MS,
  LoginThrottle,
} from './throttle';

const T0 = 1_790_000_000_000;

describe('LoginThrottle', () => {
  it('locks a source for a minute on the fifth failure and not before', () => {
    const throttle = new LoginThrottle();
    for (let attempt = 1; attempt < FAILURE_THRESHOLD; attempt += 1) {
      const outcome = throttle.recordFailure('10.0.0.1', T0 + attempt);
      expect(outcome, `attempt ${attempt}`).toEqual({ failures: attempt, lockedFor: 0 });
      expect(throttle.lockedFor('10.0.0.1', T0 + attempt)).toBe(0);
    }
    const fifth = throttle.recordFailure('10.0.0.1', T0 + FAILURE_THRESHOLD);
    expect(fifth.lockedFor).toBe(LOCKOUT_MS);
    expect(throttle.lockedFor('10.0.0.1', T0 + FAILURE_THRESHOLD)).toBe(LOCKOUT_MS);
    expect(throttle.lockedFor('10.0.0.1', T0 + FAILURE_THRESHOLD + LOCKOUT_MS - 1)).toBe(1);
    expect(throttle.lockedFor('10.0.0.1', T0 + FAILURE_THRESHOLD + LOCKOUT_MS)).toBe(0);
  });

  it('keeps sources apart', () => {
    const throttle = new LoginThrottle();
    for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt += 1) {
      throttle.recordFailure('10.0.0.1', T0);
    }
    expect(throttle.lockedFor('10.0.0.1', T0)).toBe(LOCKOUT_MS);
    expect(throttle.lockedFor('10.0.0.2', T0)).toBe(0);
    expect(throttle.recordFailure('10.0.0.2', T0)).toEqual({ failures: 1, lockedFor: 0 });
  });

  it('starts counting again once a lock has lapsed', () => {
    const throttle = new LoginThrottle();
    for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt += 1) {
      throttle.recordFailure('10.0.0.1', T0);
    }
    const later = T0 + LOCKOUT_MS;
    expect(throttle.lockedFor('10.0.0.1', later)).toBe(0);
    expect(throttle.recordFailure('10.0.0.1', later)).toEqual({ failures: 1, lockedFor: 0 });
    for (let attempt = 0; attempt < FAILURE_THRESHOLD - 2; attempt += 1) {
      expect(throttle.recordFailure('10.0.0.1', later).lockedFor).toBe(0);
    }
    expect(throttle.recordFailure('10.0.0.1', later).lockedFor).toBe(LOCKOUT_MS);
  });

  it('a success forgets that source, and only that source', () => {
    const throttle = new LoginThrottle();
    for (let attempt = 0; attempt < FAILURE_THRESHOLD - 1; attempt += 1) {
      throttle.recordFailure('10.0.0.1', T0);
      throttle.recordFailure('10.0.0.2', T0);
    }
    throttle.reset('10.0.0.1');
    expect(throttle.recordFailure('10.0.0.1', T0)).toEqual({ failures: 1, lockedFor: 0 });
    expect(throttle.recordFailure('10.0.0.2', T0).lockedFor).toBe(LOCKOUT_MS);
  });

  it('locks everyone once failures across all sources reach the global threshold', () => {
    const throttle = new LoginThrottle();
    // Each source stays under its own threshold; only the total crosses.
    for (let n = 0; n < GLOBAL_FAILURE_THRESHOLD - 1; n += 1) {
      const outcome = throttle.recordFailure(
        `10.0.${Math.floor(n / (FAILURE_THRESHOLD - 1))}.1`,
        T0,
      );
      expect(outcome.lockedFor, `failure ${n + 1}`).toBe(0);
    }
    const last = throttle.recordFailure('10.9.9.9', T0);
    expect(last.lockedFor).toBe(LOCKOUT_MS);
    expect(throttle.lockedFor('192.0.2.1', T0)).toBe(LOCKOUT_MS);
    expect(throttle.lockedFor('192.0.2.1', T0 + LOCKOUT_MS)).toBe(0);
    // A success on one source does not lift the global lock.
    throttle.reset('10.9.9.9');
    expect(throttle.lockedFor('10.9.9.9', T0)).toBe(LOCKOUT_MS);
  });

  it('forgets a source that has been quiet, so the map does not grow without bound', () => {
    const throttle = new LoginThrottle();
    throttle.recordFailure('10.0.0.1', T0);
    throttle.recordFailure('10.0.0.2', T0);
    expect(throttle.size).toBe(3); // two sources and the global entry
    throttle.recordFailure('10.0.0.3', T0 + IDLE_MS + 1);
    expect(throttle.size).toBe(2); // 10.0.0.3 and the global entry, which was just touched
    // A quiet stretch also restarts a live count.
    throttle.recordFailure('10.0.0.3', T0 + 2 * IDLE_MS + 2);
    expect(throttle.recordFailure('10.0.0.3', T0 + 2 * IDLE_MS + 2).failures).toBe(2);
  });

  it('honours custom thresholds', () => {
    const throttle = new LoginThrottle({ threshold: 2, lockoutMs: 5, globalThreshold: 100 });
    expect(throttle.recordFailure('a', T0).lockedFor).toBe(0);
    expect(throttle.recordFailure('a', T0).lockedFor).toBe(5);
    expect(throttle.lockedFor('a', T0 + 5)).toBe(0);
  });
});
