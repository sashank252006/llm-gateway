import type { RateLimitStore, RateLimitResult } from './store.js';

interface Bucket {
  tokens: number;
  lastRefill: number;
  lastSeen: number;
}

export class MemoryBucket implements RateLimitStore {
  private buckets = new Map<string, Bucket>();
  private checksSinceSweep = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly idleTtlMs = 10 * 60_000,
    private readonly sweepEvery = 100,
  ) {}

  async check(
    keyId: string,
    capacity: number,
    refillPerSecond: number,
    cost = 1
  ): Promise<RateLimitResult> {
    const now = this.now();
    if (++this.checksSinceSweep >= this.sweepEvery) {
      this.checksSinceSweep = 0;
      this.sweep(now);
    }
    let bucket = this.buckets.get(keyId);

    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now, lastSeen: now };
      this.buckets.set(keyId, bucket);
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
    bucket.lastRefill = now;
    bucket.lastSeen = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, tokensRemaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }

    const retryAfterMs = Math.ceil(((cost - bucket.tokens) / refillPerSecond) * 1000);
    return { allowed: false, tokensRemaining: 0, retryAfterMs };
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastSeen > this.idleTtlMs) this.buckets.delete(key);
    }
  }

  /** Useful for deterministic unit tests and operational diagnostics. */
  get size(): number { return this.buckets.size; }
}
