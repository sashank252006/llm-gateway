import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

export function healthRouter(prisma: PrismaClient, redis: Redis): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (_req, res) => {
    let dbOk = false;
    let redisOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      // db unavailable
    }
    try {
      await redis.ping();
      redisOk = true;
    } catch {
      // Redis is an accelerator, so readiness remains true while it is degraded.
    }
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'degraded',
      redis: redisOk ? 'ok' : 'degraded',
    });
  });

  return router;
}
