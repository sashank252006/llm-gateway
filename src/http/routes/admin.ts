import { Router, Request, Response, NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { generateKey, hashKey, getKeyPrefix, evictKey } from '../../keys/index.js';
import { GatewayError } from '../../domain/errors.js';
import { env } from '../../config/env.js';
import { breakerStore } from '../../resilience/breaker.js';

function adminAuth(req: Request, _res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return next(new GatewayError('invalid_api_key', 'Admin token required'));
  }
  const token = auth.slice(7);
  try {
    const a = Buffer.from(token);
    const b = Buffer.from(env.ADMIN_TOKEN);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return next(new GatewayError('invalid_api_key', 'Invalid admin token'));
    }
    next();
  } catch {
    next(new GatewayError('invalid_api_key', 'Invalid admin token'));
  }
}

export function adminRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(adminAuth);

  // Create key
  router.post('/admin/v1/keys', async (req: Request, res: Response, next: NextFunction) => {
    const { name, rate_limit_rpm, rate_limit_burst, max_output_tokens_cap } = req.body ?? {};
    if (!name) return next(new GatewayError('invalid_request', 'name is required'));

    const plainKey = generateKey();
    const kHash = hashKey(plainKey);
    const kPrefix = getKeyPrefix(plainKey);

    try {
      const key = await prisma.apiKey.create({
        data: {
          name,
          keyPrefix: kPrefix,
          keyHash: kHash,
          rateLimitRpm: rate_limit_rpm ?? 60,
          rateLimitBurst: rate_limit_burst ?? 20,
          maxOutputTokensCap: max_output_tokens_cap ?? 4096,
        },
      });
      res.status(201).json({
        id: key.id,
        name: key.name,
        key: plainKey,
        key_prefix: key.keyPrefix,
        rate_limit_rpm: key.rateLimitRpm,
        rate_limit_burst: key.rateLimitBurst,
        max_output_tokens_cap: key.maxOutputTokensCap,
        created_at: key.createdAt,
      });
    } catch (err) {
      next(err);
    }
  });

  // List keys
  router.get('/admin/v1/keys', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const keys = await prisma.apiKey.findMany({
        select: {
          id: true, name: true, keyPrefix: true, rateLimitRpm: true,
          rateLimitBurst: true, maxOutputTokensCap: true, cacheEnabled: true,
          createdAt: true, revokedAt: true, lastUsedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ data: keys });
    } catch (err) { next(err); }
  });

  // Update key
  router.patch('/admin/v1/keys/:id', async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { rate_limit_rpm, rate_limit_burst, max_output_tokens_cap, cache_enabled } = req.body ?? {};
    try {
      const updated = await prisma.apiKey.update({
        where: { id },
        data: {
          ...(rate_limit_rpm !== undefined && { rateLimitRpm: rate_limit_rpm }),
          ...(rate_limit_burst !== undefined && { rateLimitBurst: rate_limit_burst }),
          ...(max_output_tokens_cap !== undefined && { maxOutputTokensCap: max_output_tokens_cap }),
          ...(cache_enabled !== undefined && { cacheEnabled: cache_enabled }),
        },
      });
      res.json({ id: updated.id, name: updated.name, updated: true });
    } catch (err) { next(err); }
  });

  // Revoke key
  router.post('/admin/v1/keys/:id/revoke', async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    try {
      const key = await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      evictKey(key.keyHash);
      res.json({ id: key.id, revoked: true });
    } catch (err) { next(err); }
  });

  // Usage query
  router.get('/admin/v1/usage', async (req: Request, res: Response, next: NextFunction) => {
    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 7 * 86400000);
    const to = req.query.to ? new Date(req.query.to as string) : new Date();
    try {
      const data = await prisma.$queryRaw`
        SELECT api_key_id, date_trunc('day', created_at) AS day,
          count(*)::int AS requests,
          sum(input_tokens)::int AS input_tokens,
          sum(output_tokens)::int AS output_tokens,
          sum(cost_usd)::numeric AS cost_usd,
          avg(cache_hit::int)::float AS cache_hit_rate
        FROM usage_events
        WHERE created_at >= ${from} AND created_at <= ${to}
        GROUP BY 1, 2 ORDER BY 2 DESC, 1
      `;
      res.json({ data });
    } catch (err) { next(err); }
  });

  // Provider health
  router.get('/admin/v1/providers/health', async (req: Request, res: Response, next: NextFunction) => {
    const windowMin = parseInt((req.query.window as string) ?? '60', 10);
    try {
      const dbData = await prisma.$queryRaw`
        SELECT provider, count(*)::int AS attempts,
          (count(*) FILTER (WHERE outcome NOT IN ('success', 'skipped_circuit_open'))::float
            / NULLIF(count(*) FILTER (WHERE outcome <> 'skipped_circuit_open'), 0)) AS error_rate
        FROM provider_attempts
        WHERE created_at >= now() - (${windowMin} || ' minutes')::interval
        GROUP BY provider
      `;
      const circuits = ['openai', 'anthropic'].map((p) => ({
        provider: p,
        circuit_state: breakerStore.get(p).state,
      }));
      res.json({ data: dbData, circuits });
    } catch (err) { next(err); }
  });

  return router;
}

