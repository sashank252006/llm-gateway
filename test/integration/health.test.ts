import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { getPrisma } from '../../src/infra/prisma.js';
import { getRedis } from '../../src/infra/redis.js';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

const integration = process.env.RUN_INTEGRATION === '1';

describe.runIf(integration)('health integration', () => {
  let prisma: PrismaClient;
  let redis: Redis;

  beforeAll(async () => {
    prisma = getPrisma();
    redis = getRedis();
    await redis.connect();
  });
  afterAll(async () => { redis.disconnect(); await prisma.$disconnect(); });

  it('reports the database and Redis as ready', async () => {
    const response = await request(createApp({ prisma, redis })).get('/readyz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
  });
});
