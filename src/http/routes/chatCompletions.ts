import express, { Router, Request, Response, NextFunction } from 'express';
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
  cacheRequestsTotal,
  rateLimitedTotal,
  streamFirstByteOverheadSeconds,
} from '../../observability/metrics.js';
import type { ChatRequest, Usage } from '../../domain/types.js';
import type { AttemptRecord } from '../../resilience/executor.js';
import { computeCost } from '../../usage/cost.js';

export function chatCompletionsRouter(deps: { prisma: PrismaClient; redis: Redis }): Router {
  const router = Router();
  const redisBucket = new RedisBucket(deps.redis);
  const memBucket = new MemoryBucket();

  const rateLimit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const apiKey = req.apiKey!;
    const refillPerSecond = apiKey.rateLimitRpm / 60;
    try {
      let result;
      try {
        result = await redisBucket.check(apiKey.id, apiKey.rateLimitBurst, refillPerSecond);
      } catch {
        result = await memBucket.check(apiKey.id, apiKey.rateLimitBurst, refillPerSecond);
      }
      if (!result.allowed) {
        rateLimitedTotal.inc();
        const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
        return next(new GatewayError('rate_limit_exceeded', `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`, { retryAfterSeconds }));
      }
      res.setHeader('x-ratelimit-limit', apiKey.rateLimitRpm);
      res.setHeader('x-ratelimit-remaining', result.tokensRemaining);
      next();
    } catch (err) { next(err); }
  };

  router.post(
    '/v1/chat/completions',
    authMiddleware(deps.prisma),
    rateLimit,
    express.json({ limit: env.BODY_LIMIT }),
    validateChatRequest,
    async (req: Request, res: Response, next: NextFunction) => {
      const startTime = req.startTime ?? Date.now();
      const apiKey = req.apiKey!;
      const body = req.body as ChatRequest;
      const alias = body.model;

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

            if (body.stream) {
              const sse = new SSEWriter(res);
              sse.start();
              for await (const chunk of replayAsStream(cached)) {
                if (!body.stream_options?.include_usage && chunk.usage) {
                  const { usage: _usage, ...rest } = chunk;
                  await sse.write(rest);
                } else {
                  await sse.write(chunk);
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
              costUsd: 0,
              savedCostUsd: computeCost(cached.provider, cached.model, cached.response.usage.prompt_tokens, cached.response.usage.completion_tokens) ?? 0,
              latencyMs,
              attemptRecords: [],
            });
            res.locals.requestLog = {
              api_key_id: apiKey.id, provider: cached.provider, model: cached.model,
              fallback: false, attempts: 0,
              input_tokens: 0, output_tokens: 0, cost_usd: 0,
              saved_cost_usd: computeCost(cached.provider, cached.model, cached.response.usage.prompt_tokens, cached.response.usage.completion_tokens),
              error_code: null,
            };
            return;
          }
          cacheResult = 'MISS';
          cacheRequestsTotal.inc({ result: 'miss' });
        } catch {
          // A failed cached-stream write is already a committed response. Never
          // fall through and call a provider after sending part of that reply.
          if (res.headersSent) {
            if (!res.writableEnded) res.end();
            return;
          }
          cacheResult = 'SKIP';
          cacheRequestsTotal.inc({ result: 'skip' });
        }
      } else {
        cacheRequestsTotal.inc({ result: 'skip' });
      }

      const abortController = new AbortController();
      // IncomingMessage's close event is not a reliable client-disconnect
      // signal after the request body has been consumed. Response close is.
      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
      });
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
        let finalAttempts: AttemptRecord[] = [];
        let finishReason: 'stop' | 'length' | 'content_filter' | undefined;
        let streamInterrupted = false;
        let upstreamStartedAtMs: number | undefined;

        try {
          for await (const { chunk, provider, model, attempts, upstreamStartedAtMs: streamStartedAtMs, upstreamFirstByteLatencyMs } of streamWithResilience(
            body,
            route.chain,
            callCtx
          )) {
            finalProvider = provider;
            finalModel = model;
            finalAttempts = attempts;
            upstreamStartedAtMs = streamStartedAtMs;

            if (!committed) {
              committed = true;
              ttfbMs = Date.now() - startTime;
              streamFirstByteOverheadSeconds.observe(Math.max(0, ttfbMs - upstreamFirstByteLatencyMs) / 1000);
              res.setHeader('x-gateway-alias', alias);
              res.setHeader('x-gateway-provider', provider);
              res.setHeader('x-gateway-cache', cacheResult);
              res.setHeader('x-gateway-fallback', String(attempts.length > 1));
              res.setHeader('x-gateway-attempts', String(attempts.length));
              sse.start();
            }

            if (chunk.usage) lastUsage = chunk.usage;
            if (chunk.choices[0]?.delta.content) {
              accContent += chunk.choices[0].delta.content;
            }
            if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

            const toSend =
              !body.stream_options?.include_usage && chunk.usage
                ? { ...chunk, usage: undefined }
                : chunk;
            await sse.write(toSend, abortController.signal);
          }
          sse.done();
        } catch (err) {
          if (committed) {
            streamInterrupted = true;
            finalAttempts = (err instanceof GatewayError && Array.isArray(err.attempts) ? err.attempts : finalAttempts) as AttemptRecord[];
            sse.error({
              message: err instanceof Error ? err.message : 'Stream error',
              code: err instanceof GatewayError ? err.code : 'internal_error',
              request_id: req.requestId,
            });
          } else {
            const attempts = (err instanceof GatewayError && Array.isArray(err.attempts) ? err.attempts : []) as AttemptRecord[];
            const latencyMs = Date.now() - startTime;
            res.locals.upstreamLatencyMs = attempts.reduce((total, attempt) => total + attempt.latencyMs, 0);
            enqueueUsage({
              requestId: req.requestId, apiKeyId: apiKey.id, createdAt: new Date(startTime), alias,
              stream: true, cacheHit: false, fallbackUsed: attempts.length > 1, attempts: attempts.length,
              status: 'error', httpStatus: err instanceof GatewayError ? err.httpStatus : 500,
              errorCode: err instanceof GatewayError ? err.code : 'internal_error', latencyMs, attemptRecords: attempts,
            });
            res.locals.requestLog = {
              api_key_id: apiKey.id, provider: null, model: null,
              fallback: attempts.some((attempt) => attempt.provider !== route.chain[0]?.provider), attempts: attempts.length,
              input_tokens: null, output_tokens: null, cost_usd: null,
              error_code: err instanceof GatewayError ? err.code : 'internal_error',
            };
            return next(err);
          }
        }

        const latencyMs = Date.now() - startTime;
        upstreamLatencyMs = upstreamStartedAtMs === undefined ? 0 : Date.now() - upstreamStartedAtMs;
        res.locals.upstreamLatencyMs = upstreamLatencyMs;

        if (!streamInterrupted && cacheDecision.cacheable && lastUsage && accContent && finishReason === 'stop' && cacheKey) {
          void cacheSet(
            deps.redis,
            cacheKey,
            {
              response: {
                id: `chatcmpl-${req.requestId}`,
                object: 'chat.completion',
                created: Math.floor(startTime / 1000),
                model: finalModel,
                choices: [{ index: 0, message: { role: 'assistant', content: accContent }, finish_reason: finishReason }],
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
          status: abortController.signal.aborted ? 'client_aborted' : streamInterrupted ? 'stream_interrupted' : committed ? 'ok' : 'error',
          httpStatus: 200,
          inputTokens: lastUsage?.prompt_tokens,
          outputTokens: lastUsage?.completion_tokens,
          latencyMs,
          upstreamLatencyMs,
          ttfbMs,
          attemptRecords: finalAttempts as Parameters<typeof enqueueUsage>[0]['attemptRecords'],
        });
        res.locals.requestLog = {
          api_key_id: apiKey.id, provider: finalProvider || null, model: finalModel || null,
          fallback: finalAttempts.length > 1, attempts: finalAttempts.length,
          input_tokens: lastUsage?.prompt_tokens ?? null, output_tokens: lastUsage?.completion_tokens ?? null,
          cost_usd: lastUsage && finalProvider && finalModel ? computeCost(finalProvider, finalModel, lastUsage.prompt_tokens, lastUsage.completion_tokens) : null,
          error_code: streamInterrupted ? 'upstream_error' : null,
        };
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

        res.locals.upstreamLatencyMs = upstreamMs;

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
        res.locals.requestLog = {
          api_key_id: apiKey.id, provider: result.provider, model: result.model,
          fallback: result.fallbackUsed, attempts: result.attempts.length,
          input_tokens: result.usage.prompt_tokens, output_tokens: result.usage.completion_tokens,
          cost_usd: computeCost(result.provider, result.model, result.usage.prompt_tokens, result.usage.completion_tokens),
          error_code: null,
        };
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        const failedAttempts = (err instanceof GatewayError && Array.isArray(err.attempts) ? err.attempts : []) as AttemptRecord[];
        res.locals.upstreamLatencyMs = failedAttempts.reduce((total, attempt) => total + attempt.latencyMs, 0);
        const httpStatus = err instanceof GatewayError ? err.httpStatus : 500;
        enqueueUsage({
          requestId: req.requestId,
          apiKeyId: apiKey.id,
          createdAt: new Date(startTime),
          alias,
          stream: false,
          cacheHit: false,
          fallbackUsed: failedAttempts.some((attempt) => attempt.provider !== route.chain[0]?.provider),
          attempts: failedAttempts.length,
          status: err instanceof GatewayError && err.code === 'client_aborted' ? 'client_aborted' : 'error',
          httpStatus,
          errorCode: err instanceof GatewayError ? err.code : 'internal_error',
          latencyMs,
          attemptRecords: failedAttempts,
        });
        res.locals.requestLog = {
          api_key_id: apiKey.id, provider: null, model: null,
          fallback: failedAttempts.some((attempt) => attempt.provider !== route.chain[0]?.provider), attempts: failedAttempts.length,
          input_tokens: null, output_tokens: null, cost_usd: null,
          error_code: err instanceof GatewayError ? err.code : 'internal_error',
        };
        next(err);
      }
    }
  );

  return router;
}
