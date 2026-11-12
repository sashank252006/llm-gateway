import { type Redis } from 'ioredis';
import type { RateLimitStore, RateLimitResult } from './store.js';
import { logger } from '../observability/logger.js';
import { tokenBucketLua } from './lua.js';

const luaScript = tokenBucketLua;
let lastScriptReloadWarningAt = 0;

export class RedisBucket implements RateLimitStore {
  private redis: Redis;
  private sha: string | null = null;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private async loadScript(): Promise<string> {
    if (this.sha) return this.sha;
    this.sha = (await this.redis.script('LOAD', luaScript)) as string;
    return this.sha;
  }

  async check(
    keyId: string,
    capacity: number,
    refillPerSecond: number,
    cost = 1
  ): Promise<RateLimitResult> {
    const key = `gw:v1:rl:${keyId}`;

    try {
      const sha = await this.loadScript();
      const result = (await this.redis.evalsha(
        sha,
        1,
        key,
        String(capacity),
        String(refillPerSecond),
        String(cost)
      )) as [number, number, number];

      return {
        allowed: result[0] === 1,
        tokensRemaining: result[1],
        retryAfterMs: result[2],
      };
    } catch (err) {
      // EVAL is only a recovery path for Redis losing its script cache. Retrying
      // connection failures doubles user-visible latency while Redis is down.
      if (!(err instanceof Error) || !err.message.includes('NOSCRIPT')) throw err;
      if (Date.now() - lastScriptReloadWarningAt > 60_000) {
        lastScriptReloadWarningAt = Date.now();
        logger.warn({ msg: 'Redis script cache was cleared; reloading rate-limit script' });
      }
      this.sha = null;
      const result = (await this.redis.eval(
        luaScript,
        1,
        key,
        String(capacity),
        String(refillPerSecond),
        String(cost)
      )) as [number, number, number];

      return {
        allowed: result[0] === 1,
        tokensRemaining: result[1],
        retryAfterMs: result[2],
      };
    }
  }
}
