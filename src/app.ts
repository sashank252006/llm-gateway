import express from 'express';
import { fileURLToPath } from 'url';
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

  app.use(requestIdMiddleware);

  // Health & metrics (no auth)
  app.use(healthRouter(deps.prisma, deps.redis));
  app.use(metricsRouter());

  // Public API
  app.use(modelsRouter(deps.prisma));
  app.use(chatCompletionsRouter(deps));

  // Admin API
  app.use('/admin', express.static(fileURLToPath(new URL('../public/', import.meta.url))));
  app.use(adminRouter(deps.prisma));

  // Error handler must be LAST
  app.use(errorHandler);

  return app;
}
