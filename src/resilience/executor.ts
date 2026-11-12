import type { ChatRequest, ChatResponse, ChatChunk, Target, CallContext, Usage } from '../domain/types.js';
import { getAdapter } from '../providers/registry.js';
import { GatewayError, UpstreamError } from '../domain/errors.js';
import {
  isBreakerAllowed,
  tryBreakerProbe,
  recordBreakerSuccess,
  recordBreakerFailure,
} from './breaker.js';
import { exponentialBackoffMs } from './retry.js';
import { env } from '../config/env.js';
import {
  upstreamDuration,
  providerErrorsTotal,
  fallbacksTotal,
  overheadSeconds,
} from '../observability/metrics.js';

export interface AttemptRecord {
  attemptNo: number;
  provider: string;
  model: string;
  outcome: string;
  httpStatus?: number;
  latencyMs: number;
}

export interface ExecutionResult {
  response: ChatResponse;
  usage: Usage;
  provider: string;
  model: string;
  attempts: AttemptRecord[];
  fallbackUsed: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithResilience(
  req: ChatRequest,
  targets: Target[],
  ctx: CallContext
): Promise<ExecutionResult> {
  const attempts: AttemptRecord[] = [];
  let fallbackUsed = false;

  const overallDeadline = AbortSignal.timeout(env.REQUEST_OVERALL_DEADLINE_MS);
  const combinedSignal = AbortSignal.any([ctx.signal, overallDeadline]);
  const callCtx: CallContext = { ...ctx, signal: combinedSignal };

  for (let targetIdx = 0; targetIdx < targets.length; targetIdx++) {
    const target = targets[targetIdx];
    if (targetIdx > 0) {
      fallbackUsed = true;
      fallbacksTotal.inc({ from: targets[targetIdx - 1]!.provider, to: target.provider });
    }

    // Circuit breaker check
    const allowed = isBreakerAllowed(target.provider);
    const probeAllowed = !allowed && tryBreakerProbe(target.provider);

    if (!allowed && !probeAllowed) {
      attempts.push({
        attemptNo: attempts.length + 1,
        provider: target.provider,
        model: target.model,
        outcome: 'skipped_circuit_open',
        latencyMs: 0,
      });
      continue;
    }

    // Retry loop
    for (let attempt = 0; attempt <= env.RETRY_MAX_ATTEMPTS; attempt++) {
      if (combinedSignal.aborted) {
        throw new GatewayError('upstream_timeout', 'Overall request deadline exceeded');
      }

      if (attempt > 0) {
        await sleep(exponentialBackoffMs(attempt - 1));
      }

      const start = Date.now();
      try {
        const adapter = getAdapter(target.provider);
        const result = await adapter.complete(req, target, callCtx);
        const latencyMs = Date.now() - start;

        upstreamDuration.observe({ provider: target.provider, outcome: 'success' }, latencyMs / 1000);
        recordBreakerSuccess(target.provider);

        attempts.push({
          attemptNo: attempts.length + 1,
          provider: target.provider,
          model: target.model,
          outcome: 'success',
          latencyMs,
        });

        return { response: result.response, usage: result.usage, provider: target.provider, model: target.model, attempts, fallbackUsed };
      } catch (err: unknown) {
        const latencyMs = Date.now() - start;

        if (err instanceof UpstreamError) {
          providerErrorsTotal.inc({ provider: target.provider, class: err.errorClass });
          attempts.push({
            attemptNo: attempts.length + 1,
            provider: target.provider,
            model: target.model,
            outcome: err.errorClass,
            httpStatus: err.httpStatus,
            latencyMs,
          });
          upstreamDuration.observe({ provider: target.provider, outcome: err.errorClass }, latencyMs / 1000);

          if (!err.retryable || attempt >= env.RETRY_MAX_ATTEMPTS) {
            recordBreakerFailure(target.provider);
            if (!err.fallbackable) {
              throw new GatewayError('invalid_request', 'Provider rejected the request');
            }
            break; // try next target
          }
          recordBreakerFailure(target.provider);
          // continue retry loop
        } else {
          throw err;
        }
      }
    }
  }

  const allSkipped = attempts.every((a) => a.outcome === 'skipped_circuit_open');
  if (allSkipped) {
    throw new GatewayError('all_providers_unavailable', 'All provider circuits are open');
  }

  throw new GatewayError('upstream_error', 'All providers failed');
}

export interface StreamResult {
  chunk: ChatChunk;
  provider: string;
  model: string;
  attempts: AttemptRecord[];
}

export async function* streamWithResilience(
  req: ChatRequest,
  targets: Target[],
  ctx: CallContext
): AsyncGenerator<StreamResult> {
  const attempts: AttemptRecord[] = [];

  const overallDeadline = AbortSignal.timeout(env.REQUEST_OVERALL_DEADLINE_MS);
  const combinedSignal = AbortSignal.any([ctx.signal, overallDeadline]);
  const callCtx: CallContext = { ...ctx, signal: combinedSignal };

  for (let targetIdx = 0; targetIdx < targets.length; targetIdx++) {
    const target = targets[targetIdx];
    if (targetIdx > 0) {
      fallbacksTotal.inc({ from: targets[targetIdx - 1]!.provider, to: target.provider });
    }

    const allowed = isBreakerAllowed(target.provider);
    const probeAllowed = !allowed && tryBreakerProbe(target.provider);

    if (!allowed && !probeAllowed) {
      attempts.push({
        attemptNo: attempts.length + 1,
        provider: target.provider,
        model: target.model,
        outcome: 'skipped_circuit_open',
        latencyMs: 0,
      });
      continue;
    }

    const start = Date.now();
    try {
      const adapter = getAdapter(target.provider);
      const iterable = adapter.stream(req, target, callCtx);
      const it = iterable[Symbol.asyncIterator]();

      // Pull first chunk BEFORE commit point — still retryable/fallbackable here
      const first = await it.next();
      if (first.done) continue;

      const latencyMs = Date.now() - start;
      recordBreakerSuccess(target.provider);
      attempts.push({
        attemptNo: attempts.length + 1,
        provider: target.provider,
        model: target.model,
        outcome: 'success',
        latencyMs,
      });

      // ---- COMMIT POINT: yield first chunk now ----
      yield { chunk: first.value, provider: target.provider, model: target.model, attempts: [...attempts] };

      // Stream remaining chunks
      for (;;) {
        const r = await it.next();
        if (r.done) break;
        yield { chunk: r.value, provider: target.provider, model: target.model, attempts: [...attempts] };
      }

      return; // success
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;

      if (err instanceof UpstreamError) {
        providerErrorsTotal.inc({ provider: target.provider, class: err.errorClass });
        attempts.push({
          attemptNo: attempts.length + 1,
          provider: target.provider,
          model: target.model,
          outcome: err.errorClass,
          latencyMs,
        });
        recordBreakerFailure(target.provider);

        if (!err.fallbackable) throw err;
        continue;
      }
      throw err;
    }
  }

  const allSkipped = attempts.every((a) => a.outcome === 'skipped_circuit_open');
  if (allSkipped) throw new GatewayError('all_providers_unavailable', 'All provider circuits are open');
  throw new GatewayError('upstream_error', 'All providers failed');
}

