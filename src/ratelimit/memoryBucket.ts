import type { RateLimitStore, RateLimitResult } from './store.js';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class MemoryBucket implements RateLimitStore {
  private buckets = new Map<string, Bucket>();

  async check(
    keyId: string,
    capacity: number,
    refillPerSecond: number,
    cost = 1
  ): Promise<RateLimitResult> {
    const now = Date.now();
    let bucket = this.buckets.get(keyId);

    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      this.buckets.set(keyId, bucket);
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
    bucket.lastRefill = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, tokensRemaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }

    const retryAfterMs = Math.ceil(((cost - bucket.tokens) / refillPerSecond) * 1000);
    return { allowed: false, tokensRemaining: 0, retryAfterMs };
  }
}

