import { describe, it, expect } from 'vitest';
import { MemoryBucket } from '../../../src/ratelimit/memoryBucket.js';

describe('MemoryBucket', () => {
  it('allows first request within capacity', async () => {
    const bucket = new MemoryBucket();
    const result = await bucket.check('key1', 10, 1);
    expect(result.allowed).toBe(true);
    expect(result.tokensRemaining).toBe(9);
  });

  it('denies when capacity is fully exhausted', async () => {
    const bucket = new MemoryBucket();
    for (let i = 0; i < 10; i++) {
      await bucket.check('key2', 10, 1);
    }
    const result = await bucket.check('key2', 10, 1);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('different keys have independent buckets', async () => {
    const bucket = new MemoryBucket();
    // Drain key3
    for (let i = 0; i < 5; i++) await bucket.check('key3', 5, 1);
    // key4 should still have full capacity
    const result = await bucket.check('key4', 5, 1);
    expect(result.allowed).toBe(true);
  });
});

