import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { RedisBucket } from '../../src/ratelimit/redisBucket.js';

const integration = process.env.RUN_INTEGRATION === '1';

describe.runIf(integration)('Redis token bucket concurrency', () => {
  let redis: Redis;
  const keyId = `concurrency-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL);
    await redis.ping();
  });
  afterAll(async () => {
    await redis?.del(`gw:v1:rl:${keyId}`);
    await redis?.quit();
  });

  it('allows exactly the bucket capacity under 200 concurrent checks', async () => {
    const bucket = new RedisBucket(redis);
    const results = await Promise.all(Array.from({ length: 200 }, () => bucket.check(keyId, 20, 1)));
    expect(results.filter((result) => result.allowed)).toHaveLength(20);
  });
});
