import express from 'express';
import { requestIdMiddleware } from './http/middleware/requestId.js';
import { errorHandler } from './http/middleware/errorHandler.js';
import { healthRouter } from './http/routes/health.js';
import { metricsRouter } from './http/routes/metrics.js';
import { modelsRouter } from './http/routes/models.js';
import { chatCompletionsRouter } from './http/routes/chatCompletions.js';
import { adminRouter } from './http/routes/admin.js';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

export function createApp(deps: { prisma: PrismaClient; redis: Redis }) {
  const app = express();

  app.set('trust proxy', true);

  app.use(requestIdMiddleware);
  app.use(express.json({ limit: '1mb' }));

  // Health & metrics (no auth)
  app.use(healthRouter(deps.prisma));
  app.use(metricsRouter());

  // Public API
  app.use(modelsRouter());
  app.use(chatCompletionsRouter(deps));

  // Admin API
  app.use(adminRouter(deps.prisma));

  // Error handler must be LAST
  app.use(errorHandler);

  return app;
}

