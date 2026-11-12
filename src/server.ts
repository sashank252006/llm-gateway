import 'dotenv/config';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { loadRouteConfig } from './config/routing.js';
import { loadPrices } from './config/prices.js';
import { getPrisma } from './infra/prisma.js';
import { getRedis } from './infra/redis.js';
import { logger } from './observability/logger.js';
import { initUsageRecorder, flushAndShutdown } from './usage/recorder.js';

async function main() {
  const routes = loadRouteConfig();
  const prices = loadPrices();
  for (const [alias, route] of Object.entries(routes.aliases)) {
    for (const target of route.chain) {
      if (!prices[target.model]) {
        throw new Error(`Route alias ${alias} references ${target.model}, which has no price entry`);
      }
    }
  }

  const prisma = getPrisma();
  const redis = getRedis();

  try {
    await redis.connect();
  } catch (err) {
    logger.warn({ msg: 'Redis connection failed at startup, running degraded', error: err });
  }

  initUsageRecorder(prisma);

  const app = createApp({ prisma, redis });

  const server = app.listen(env.PORT, () => {
    logger.info({ msg: 'Gateway listening', port: env.PORT, env: env.NODE_ENV });
  });

  const shutdown = async (signal: string) => {
    logger.info({ msg: `Received ${signal}, shutting down gracefully` });
    server.close(async () => {
      await flushAndShutdown();
      await prisma.$disconnect();
      redis.disconnect();
      logger.info('Shutdown complete');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
