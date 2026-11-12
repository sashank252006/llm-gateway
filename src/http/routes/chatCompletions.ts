import { Router, Request, Response, NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { authMiddleware } from '../middleware/auth.js';
import { validateChatRequest } from '../middleware/validate.js';
import { resolveAlias } from '../../routing/router.js';
import { executeWithResilience, streamWithResilience } from '../../resilience/executor.js';
import { cacheGet, cacheSet, replayAsStream } from '../../cache/cache.js';
import { buildCacheKey, hashChain } from '../../cache/normalize.js';
import { isCacheable } from '../../cache/policy.js';
import { RedisBucket } from '../../ratelimit/redisBucket.js';
import { MemoryBucket } from '../../ratelimit/memoryBucket.js';
import { GatewayError } from '../../domain/errors.js';
import { SSEWriter } from '../sse.js';
import { enqueueUsage } from '../../usage/recorder.js';
import { env } from '../../config/env.js';
import {
  requestsTotal,
  requestDuration,
  cacheRequestsTotal,
  rateLimitedTotal,
  overheadSeconds,
} from '../../observability/metrics.js';
import type { ChatRequest, Usage } from '../../domain/types.js';

export function chatCompletionsRouter(deps: { prisma: PrismaClient; redis: Redis }): Router {
  const router = Router();
  const redisBucket = new RedisBucket(deps.redis);
  const memBucket = new MemoryBucket();

  router.post(
    '/v1/chat/completions',
    authMiddleware(deps.prisma),
    validateChatRequest,
    async (req: Request, res: Response, next: NextFunction) => {
      const startTime = req.startTime ?? Date.now();
      const apiKey = req.apiKey!;
      const body = req.body as ChatRequest;
      const alias = body.model;

      // Rate limiting
      const refillPerSecond = apiKey.rateLimitRpm / 60;
      let rateLimitResult;

      try {
        rateLimitResult = await redisBucket.check(apiKey.id, apiKey.rateLimitBurst, refillPerSecond);
      } catch {
        rateLimitResult = await memBucket.check(apiKey.id, apiKey.rateLimitBurst, refillPerSecond);
      }

      if (!rateLimitResult.allowed) {
        rateLimitedTotal.inc();
        const retryAfterSec = Math.ceil(rateLimitResult.retryAfterMs / 1000);
        return next(
          new GatewayError(
            'rate_limit_exceeded',
            `Rate limit exceeded. Retry after ${retryAfterSec} seconds.`,
            { retryAfterSeconds: retryAfterSec }
          )
        );
      }

      res.setHeader('x-ratelimit-limit', apiKey.rateLimitRpm);
      res.setHeader('x-ratelimit-remaining', rateLimitResult.tokensRemaining);

      // Resolve alias
      let route;
      try {
        route = resolveAlias(alias);
      } catch (err) {
        return next(err);
      }

      // Apply max_tokens default
      if (!body.max_tokens) {
        body.max_tokens = apiKey.maxOutputTokensCap;
      }

      // Cache
      const bypassHeader = req.headers['x-gateway-cache'] === 'bypass';
      const cacheDecision = isCacheable(body, apiKey.cacheEnabled, bypassHeader);
      const chainHash = hashChain(route.chain);
      const cacheTtl = route.cacheTtlSeconds ?? env.CACHE_TTL_SECONDS;

      let cacheResult: 'HIT' | 'MISS' | 'SKIP' = 'SKIP';
      let cacheKey: string | null = null;

      if (cacheDecision.cacheable) {
        cacheKey = buildCacheKey(body, apiKey.id, alias, chainHash, apiKey.maxOutputTokensCap);
        try {
          const cached = await cacheGet(deps.redis, cacheKey);
          if (cached) {
            cacheResult = 'HIT';
            cacheRequestsTotal.inc({ result: 'hit' });

            res.setHeader('x-gateway-alias', alias);
            res.setHeader('x-gateway-provider', cached.provider);
            res.setHeader('x-gateway-cache', 'HIT');
            res.setHeader('x-gateway-fallback', 'false');
            res.setHeader('x-gateway-attempts', '0');

            const latencyMs = Date.now() - startTime;
            requestsTotal.inc({ alias, http_status: '200', cache: 'hit' });
            requestDuration.observe({ alias, stream: String(!!body.stream) }, latencyMs / 1000);

            if (body.stream) {
              const sse = new SSEWriter(res);
              sse.start();
              for await (const chunk of replayAsStream(cached)) {
                if (!body.stream_options?.include_usage && chunk.usage) {
                  const { usage: _u, ...rest } = chunk;
                  sse.write(rest);
                } else {
                  sse.write(chunk);
                }
              }
              sse.done();
            } else {
              res.json(cached.response);
            }

            enqueueUsage({
              requestId: req.requestId,
              apiKeyId: apiKey.id,
              createdAt: new Date(startTime),
              alias,
              provider: cached.provider,
              model: cached.model,
              stream: !!body.stream,
              cacheHit: true,
              fallbackUsed: false,
              attempts: 0,
              status: 'ok',
              httpStatus: 200,
              inputTokens: cached.response.usage.prompt_tokens,
              outputTokens: cached.response.usage.completion_tokens,
              latencyMs,
              attemptRecords: [],
            });
            return;
          }
          cacheResult = 'MISS';
          cacheRequestsTotal.inc({ result: 'miss' });
        } catch {
          cacheResult = 'SKIP';
          cacheRequestsTotal.inc({ result: 'skip' });
        }
      } else {
        cacheRequestsTotal.inc({ result: 'skip' });
      }

      const abortController = new AbortController();
      req.on('close', () => abortController.abort());
      const callCtx = { signal: abortController.signal, requestId: req.requestId };

      // ── Streaming ──────────────────────────────────────────────────────────
      if (body.stream) {
        const sse = new SSEWriter(res);
        let committed = false;
        let upstreamLatencyMs = 0;
        let ttfbMs: number | undefined;
        let accContent = '';
        let lastUsage: Usage | undefined;
        let finalProvider = '';
        let finalModel = '';
        let finalAttempts: { attemptNo: number }[] = [];

        try {
          for await (const { chunk, provider, model, attempts } of streamWithResilience(
            body,
            route.chain,
            callCtx
          )) {
            finalProvider = provider;
            finalModel = model;
            finalAttempts = attempts;

            if (!committed) {
              committed = true;
              ttfbMs = Date.now() - startTime;
              res.setHeader('x-gateway-alias', alias);
              res.setHeader('x-gateway-provider', provider);
              res.setHeader('x-gateway-cache', cacheResult);
              res.setHeader('x-gateway-fallback', String(attempts.length > 1));
              res.setHeader('x-gateway-attempts', String(attempts.length));
              sse.start();
            }

            if (chunk.usage) {
              lastUsage = chunk.usage;
              upstreamLatencyMs = Date.now() - startTime - (ttfbMs ?? 0);
            }
            if (chunk.choices[0]?.delta.content) {
              accContent += chunk.choices[0].delta.content;
            }

            const toSend =
              !body.stream_options?.include_usage && chunk.usage
                ? { ...chunk, usage: undefined }
                : chunk;
            sse.write(toSend);
          }
          sse.done();
        } catch (err) {
          if (committed) {
            sse.error({
              message: err instanceof Error ? err.message : 'Stream error',
              code: err instanceof GatewayError ? err.code : 'internal_error',
              request_id: req.requestId,
            });
          } else {
            return next(err);
          }
        }

        const latencyMs = Date.now() - startTime;
        requestsTotal.inc({ alias, http_status: '200', cache: cacheResult.toLowerCase() });
        requestDuration.observe({ alias, stream: 'true' }, latencyMs / 1000);
        overheadSeconds.observe((latencyMs - upstreamLatencyMs) / 1000);

        if (cacheDecision.cacheable && lastUsage && accContent && cacheKey) {
          void cacheSet(
            deps.redis,
            cacheKey,
            {
              response: {
                id: `chatcmpl-${req.requestId}`,
                object: 'chat.completion',
                created: Math.floor(startTime / 1000),
                model: finalModel,
                choices: [{ index: 0, message: { role: 'assistant', content: accContent }, finish_reason: 'stop' }],
                usage: lastUsage,
              },
              provider: finalProvider,
              model: finalModel,
            },
            cacheTtl
          );
        }

        enqueueUsage({
          requestId: req.requestId,
          apiKeyId: apiKey.id,
          createdAt: new Date(startTime),
          alias,
          provider: finalProvider,
          model: finalModel,
          stream: true,
          cacheHit: false,
          fallbackUsed: finalAttempts.length > 1,
          attempts: finalAttempts.length,
          status: committed ? 'ok' : 'error',
          httpStatus: 200,
          inputTokens: lastUsage?.prompt_tokens,
          outputTokens: lastUsage?.completion_tokens,
          latencyMs,
          upstreamLatencyMs,
          ttfbMs,
          attemptRecords: finalAttempts as Parameters<typeof enqueueUsage>[0]['attemptRecords'],
        });
        return;
      }

      // ── Non-streaming ──────────────────────────────────────────────────────
      try {
        const startUpstream = Date.now();
        const result = await executeWithResilience(body, route.chain, callCtx);
        const upstreamMs = Date.now() - startUpstream;
        const latencyMs = Date.now() - startTime;

        res.setHeader('x-gateway-alias', alias);
        res.setHeader('x-gateway-provider', result.provider);
        res.setHeader('x-gateway-cache', cacheResult);
        res.setHeader('x-gateway-fallback', String(result.fallbackUsed));
        res.setHeader('x-gateway-attempts', String(result.attempts.length));

        requestsTotal.inc({ alias, http_status: '200', cache: cacheResult.toLowerCase() });
        requestDuration.observe({ alias, stream: 'false' }, latencyMs / 1000);
        overheadSeconds.observe((latencyMs - upstreamMs) / 1000);

        if (cacheDecision.cacheable && result.response.choices[0]?.finish_reason === 'stop' && cacheKey) {
          void cacheSet(deps.redis, cacheKey, { response: result.response, provider: result.provider, model: result.model }, cacheTtl);
        }

        res.json(result.response);

        enqueueUsage({
          requestId: req.requestId,
          apiKeyId: apiKey.id,
          createdAt: new Date(startTime),
          alias,
          provider: result.provider,
          model: result.model,
          stream: false,
          cacheHit: false,
          fallbackUsed: result.fallbackUsed,
          attempts: result.attempts.length,
          status: 'ok',
          httpStatus: 200,
          inputTokens: result.usage.prompt_tokens,
          outputTokens: result.usage.completion_tokens,
          latencyMs,
          upstreamLatencyMs: upstreamMs,
          attemptRecords: result.attempts,
        });
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        const httpStatus = err instanceof GatewayError ? err.httpStatus : 500;
        requestsTotal.inc({ alias, http_status: String(httpStatus), cache: cacheResult.toLowerCase() });
        enqueueUsage({
          requestId: req.requestId,
          apiKeyId: apiKey.id,
          createdAt: new Date(startTime),
          alias,
          stream: false,
          cacheHit: false,
          fallbackUsed: false,
          attempts: 0,
          status: 'error',
          httpStatus,
          errorCode: err instanceof GatewayError ? err.code : 'internal_error',
          latencyMs,
          attemptRecords: [],
        });
        next(err);
      }
    }
  );

  return router;
}

