import type { ChatRequest, ChatResponse, ChatChunk, Target, CallContext, Usage } from '../domain/types.js';
import { getAdapter } from '../providers/registry.js';
import { GatewayError, UpstreamError } from '../domain/errors.js';
import {
  breakerStore,
} from './breaker.js';
import type { BreakerStore } from './breakerStore.js';
import { exponentialBackoffMs } from './retry.js';
import { env } from '../config/env.js';
import {
  upstreamDuration,
  providerErrorsTotal,
  fallbacksTotal,
  circuitState,
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

function sleep(ms: number, signal: AbortSignal, abortError: () => GatewayError): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    function done(): void {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function attachAttempts(error: GatewayError, attempts: AttemptRecord[]): GatewayError {
  error.attempts = [...attempts];
  return error;
}

function isBreakerFailure(error: UpstreamError): boolean {
  return ['timeout', 'network_error', 'http_5xx', 'http_429'].includes(error.errorClass);
}

function updateCircuitMetric(provider: string, breaker: BreakerStore): void {
  const state = breaker.get(provider).state;
  circuitState.set({ provider }, state === 'closed' ? 0 : state === 'half-open' ? 1 : 2);
}

function breakerAllowed(provider: string, breaker: BreakerStore): boolean {
  const allowed = breaker.isAllowed(provider);
  updateCircuitMetric(provider, breaker);
  return allowed;
}

function breakerProbe(provider: string, breaker: BreakerStore): boolean {
  const allowed = breaker.tryProbe(provider);
  updateCircuitMetric(provider, breaker);
  return allowed;
}

function breakerSucceeded(provider: string, breaker: BreakerStore): void {
  breaker.recordSuccess(provider);
  updateCircuitMetric(provider, breaker);
}

function breakerFailed(provider: string, breaker: BreakerStore): void {
  breaker.recordFailure(provider);
  updateCircuitMetric(provider, breaker);
}

export async function executeWithResilience(
  req: ChatRequest,
  targets: Target[],
  ctx: CallContext,
  breaker: BreakerStore = breakerStore,
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
    const allowed = breakerAllowed(target.provider, breaker);
    const probeAllowed = !allowed && breakerProbe(target.provider, breaker);

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
    let retryDelayMs: number | undefined;
    for (let attempt = 0; attempt <= env.RETRY_MAX_ATTEMPTS; attempt++) {
      if (combinedSignal.aborted) {
        throw attachAttempts(
          new GatewayError(
            ctx.signal.aborted ? 'client_aborted' : 'upstream_timeout',
            ctx.signal.aborted ? 'Client disconnected' : 'Overall request deadline exceeded',
          ),
          attempts,
        );
      }

      if (attempt > 0) {
        await sleep(retryDelayMs ?? exponentialBackoffMs(attempt - 1), combinedSignal, () =>
          attachAttempts(
            new GatewayError(
              ctx.signal.aborted ? 'client_aborted' : 'upstream_timeout',
              ctx.signal.aborted ? 'Client disconnected' : 'Overall request deadline exceeded',
            ),
            attempts,
          )
        );
      }

      const start = Date.now();
      try {
        const adapter = getAdapter(target.provider);
        const result = await adapter.complete(req, target, callCtx);
        const latencyMs = Date.now() - start;

        upstreamDuration.observe({ provider: target.provider, outcome: 'success' }, latencyMs / 1000);
        breakerSucceeded(target.provider, breaker);

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

        if (ctx.signal.aborted || overallDeadline.aborted) {
          throw attachAttempts(new GatewayError(
            ctx.signal.aborted ? 'client_aborted' : 'upstream_timeout',
            ctx.signal.aborted ? 'Client disconnected' : 'Overall request deadline exceeded',
          ), attempts);
        }

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
            if (isBreakerFailure(err)) breakerFailed(target.provider, breaker);
            if (!err.fallbackable) {
              throw attachAttempts(new GatewayError('invalid_request', 'Provider rejected the request'), attempts);
            }
            break; // try next target
          }
          if (isBreakerFailure(err)) breakerFailed(target.provider, breaker);
          retryDelayMs = err.retryAfterMs ?? exponentialBackoffMs(attempt);
          // continue retry loop
        } else {
          throw err;
        }
      }
    }
  }

  const allSkipped = attempts.every((a) => a.outcome === 'skipped_circuit_open');
  if (allSkipped) {
    const cooldowns = targets.map((target) => breaker.cooldownRemainingMs(target.provider)).filter((value) => value > 0).map((value) => Math.ceil(value / 1000));
    throw attachAttempts(new GatewayError('all_providers_unavailable', 'All provider circuits are open', { retryAfterSeconds: cooldowns.length > 0 ? Math.min(...cooldowns) : 1 }), attempts);
  }

  throw attachAttempts(new GatewayError('upstream_error', 'All providers failed'), attempts);
}

export interface StreamResult {
  chunk: ChatChunk;
  provider: string;
  model: string;
  attempts: AttemptRecord[];
  upstreamStartedAtMs: number;
  upstreamFirstByteLatencyMs: number;
}

export async function* streamWithResilience(
  req: ChatRequest,
  targets: Target[],
  ctx: CallContext,
  breaker: BreakerStore = breakerStore,
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

    const allowed = breakerAllowed(target.provider, breaker);
    const probeAllowed = !allowed && breakerProbe(target.provider, breaker);

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
      attempts.push({
        attemptNo: attempts.length + 1,
        provider: target.provider,
        model: target.model,
        outcome: 'success',
        latencyMs,
      });

      // ---- COMMIT POINT: yield first chunk now ----
      yield { chunk: first.value, provider: target.provider, model: target.model, attempts: [...attempts], upstreamStartedAtMs: start, upstreamFirstByteLatencyMs: latencyMs };

      // Stream remaining chunks
      for (;;) {
        const r = await it.next();
        if (r.done) break;
        yield { chunk: r.value, provider: target.provider, model: target.model, attempts: [...attempts], upstreamStartedAtMs: start, upstreamFirstByteLatencyMs: latencyMs };
      }

      breakerSucceeded(target.provider, breaker);
      return; // success
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;

      if (ctx.signal.aborted || overallDeadline.aborted) {
        throw attachAttempts(new GatewayError(
          ctx.signal.aborted ? 'client_aborted' : 'upstream_timeout',
          ctx.signal.aborted ? 'Client disconnected' : 'Overall request deadline exceeded',
        ), attempts);
      }

      if (err instanceof UpstreamError) {
        providerErrorsTotal.inc({ provider: target.provider, class: err.errorClass });
        attempts.push({
          attemptNo: attempts.length + 1,
          provider: target.provider,
          model: target.model,
          outcome: err.errorClass,
          latencyMs,
        });
        if (isBreakerFailure(err)) breakerFailed(target.provider, breaker);

        if (!err.fallbackable) throw attachAttempts(new GatewayError('invalid_request', 'Provider rejected the request'), attempts);
        continue;
      }
      throw err;
    }
  }

  const allSkipped = attempts.every((a) => a.outcome === 'skipped_circuit_open');
  if (allSkipped) {
    const cooldowns = targets.map((target) => breaker.cooldownRemainingMs(target.provider)).filter((value) => value > 0).map((value) => Math.ceil(value / 1000));
    throw attachAttempts(new GatewayError('all_providers_unavailable', 'All provider circuits are open', { retryAfterSeconds: cooldowns.length > 0 ? Math.min(...cooldowns) : 1 }), attempts);
  }
  throw attachAttempts(new GatewayError('upstream_error', 'All providers failed'), attempts);
}
