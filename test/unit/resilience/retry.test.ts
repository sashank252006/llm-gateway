import { describe, it, expect } from 'vitest';
import { exponentialBackoffMs } from '../../../src/resilience/retry.js';

describe('exponentialBackoffMs', () => {
  it('with jitter: returns value between 0 and baseMs for first attempt', () => {
    for (let i = 0; i < 20; i++) {
      const ms = exponentialBackoffMs(0, 500, 10000, true);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(500);
    }
  });

  it('without jitter: grows exponentially', () => {
    const ms0 = exponentialBackoffMs(0, 500, 10000, false);
    const ms1 = exponentialBackoffMs(1, 500, 10000, false);
    const ms2 = exponentialBackoffMs(2, 500, 10000, false);
    expect(ms1).toBeGreaterThan(ms0);
    expect(ms2).toBeGreaterThan(ms1);
  });

  it('caps at maxMs', () => {
    const ms = exponentialBackoffMs(10, 500, 1000, false);
    expect(ms).toBeLessThanOrEqual(1000);
  });
});

