import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';

export function healthRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (_req, res) => {
    let dbOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      // db unavailable
    }
    res.json({
      status: 'ok',
      db: dbOk ? 'ok' : 'degraded',
    });
  });

  return router;
}

