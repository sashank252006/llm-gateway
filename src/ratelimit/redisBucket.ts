import { type Redis } from 'ioredis';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { RateLimitStore, RateLimitResult } from './store.js';
import { logger } from '../observability/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const luaScript = readFileSync(join(__dirname, 'bucket.lua'), 'utf-8');

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
    } catch {
      logger.warn({ msg: 'EVALSHA failed, retrying with EVAL' });
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

