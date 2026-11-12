import type Redis from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  tokensRemaining: number;
  retryAfterMs: number;
}

export interface RateLimitStore {
  check(
    keyId: string,
    capacity: number,
    refillPerSecond: number,
    cost?: number
  ): Promise<RateLimitResult>;
}

