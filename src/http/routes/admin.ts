import express, { Router, Request, Response, NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { generateKey, hashKey, getKeyPrefix, evictKey } from '../../keys/index.js';
import { GatewayError } from '../../domain/errors.js';
import { env } from '../../config/env.js';
import { breakerStore } from '../../resilience/breaker.js';
import { z } from 'zod';
import { loadRouteConfig } from '../../config/routing.js';

const limitsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  rate_limit_rpm: z.number().int().min(1).max(100_000).optional(),
  rate_limit_burst: z.number().int().min(1).max(100_000).optional(),
  max_output_tokens_cap: z.number().int().min(1).max(200_000).optional(),
  cache_enabled: z.boolean().optional(),
}).strict();
const createKeySchema = limitsSchema.extend({ name: z.string().trim().min(1).max(120) });
const dateString = z.string().datetime({ offset: true });

function parsed<T>(schema: z.ZodType<T>, value: unknown, next: NextFunction): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  next(new GatewayError('invalid_request', `${issue?.path.join('.') || 'parameter'}: ${issue?.message ?? 'invalid value'}`, { param: issue?.path.join('.') }));
  return undefined;
}

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
  router.use('/admin', express.json());
  router.use('/admin', adminAuth);

  // Create key
  router.post('/admin/v1/keys', async (req: Request, res: Response, next: NextFunction) => {
    const input = parsed(createKeySchema, req.body, next);
    if (!input) return;
    const { name, rate_limit_rpm, rate_limit_burst, max_output_tokens_cap } = input;

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
    const input = parsed(limitsSchema, req.body, next);
    if (!input) return;
    if (Object.keys(input).length === 0) return next(new GatewayError('invalid_request', 'At least one mutable field is required'));
    const { rate_limit_rpm, rate_limit_burst, max_output_tokens_cap, cache_enabled } = input;
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
      evictKey(updated.keyHash);
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
    const querySchema = z.object({ from: dateString.optional(), to: dateString.optional(), api_key_id: z.string().uuid().optional() }).strict();
    const query = parsed(querySchema, req.query, next);
    if (!query) return;
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 7 * 86400000);
    const to = query.to ? new Date(query.to) : new Date();
    if (from > to) return next(new GatewayError('invalid_request', 'from must be before to', { param: 'from' }));
    try {
      const data = await prisma.$queryRaw`
        SELECT api_key_id, date_trunc('day', created_at) AS day,
          count(*)::bigint AS requests,
          coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
          coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
          sum(cost_usd)::numeric AS cost_usd,
          avg(cache_hit::int)::float AS cache_hit_rate,
          (count(*) FILTER (WHERE status <> 'ok')::float / NULLIF(count(*), 0)) AS error_rate
        FROM usage_events
        WHERE created_at >= ${from} AND created_at <= ${to}
          AND (${query.api_key_id}::uuid IS NULL OR api_key_id = ${query.api_key_id}::uuid)
        GROUP BY 1, 2 ORDER BY 2 DESC, 1
      `;
      res.json({ data });
    } catch (err) { next(err); }
  });

  // Provider health
  router.get('/admin/v1/providers/health', async (req: Request, res: Response, next: NextFunction) => {
    const input = parsed(z.object({ window: z.coerce.number().int().min(1).max(10_080).default(60) }).strict(), req.query, next);
    if (!input) return;
    const windowMin = input.window;
    try {
      const dbData = await prisma.$queryRaw`
        SELECT provider, count(*)::int AS attempts,
          (count(*) FILTER (WHERE outcome NOT IN ('success', 'skipped_circuit_open'))::float
            / NULLIF(count(*) FILTER (WHERE outcome <> 'skipped_circuit_open'), 0)) AS error_rate
        FROM provider_attempts
        WHERE created_at >= now() - (${windowMin} * interval '1 minute')
        GROUP BY provider
      `;
      const providers = [...new Set(Object.values(loadRouteConfig().aliases).flatMap((route) => route.chain.map((target) => target.provider)))];
      const circuits = providers.map((p) => ({
        provider: p,
        circuit_state: breakerStore.get(p).state,
      }));
      res.json({ data: dbData, circuits });
    } catch (err) { next(err); }
  });

  return router;
}
