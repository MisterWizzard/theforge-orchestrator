import { describe, expect, it } from 'vitest';
import {
  MAX_COMPLETION_BODY_BYTES,
  MAX_EVENTS_BYTES,
  MAX_PATCH_BYTES,
  MAX_RAW_TAIL_BYTES,
} from './index.js';

describe('transport limits', () => {
  it('keeps the completion body cap above the patch, events and raw tail caps combined', () => {
    // The worker sends patch + events + two raw output tails in one body. If
    // the body cap ever slips below their sum, a completion the worker
    // considers legal is rejected and the job re-leases instead of failing,
    // which is the defect these exist to prevent.
    expect(MAX_PATCH_BYTES + MAX_EVENTS_BYTES + 2 * MAX_RAW_TAIL_BYTES).toBeLessThan(
      MAX_COMPLETION_BODY_BYTES,
    );
    for (const limit of [
      MAX_PATCH_BYTES,
      MAX_EVENTS_BYTES,
      MAX_RAW_TAIL_BYTES,
      MAX_COMPLETION_BODY_BYTES,
    ]) {
      expect(Number.isSafeInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
  });
});
