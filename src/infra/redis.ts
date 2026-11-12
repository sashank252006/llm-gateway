import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { redisErrorsTotal } from '../observability/metrics.js';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;
  _redis = new Redis(env.REDIS_URL, {
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  _redis.on('error', (err: Error) => {
    logger.warn({ msg: 'Redis error', error: err.message });
    redisErrorsTotal.inc();
  });

  _redis.on('connect', () => logger.info('Redis connected'));

  return _redis;
}
