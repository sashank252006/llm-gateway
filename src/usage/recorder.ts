import type { PrismaClient } from '@prisma/client';
import type { AttemptRecord } from '../resilience/executor.js';
import { computeCost } from './cost.js';
import { logger } from '../observability/logger.js';
import { usageQueueDepth, usageRowsDropped, tokensTotal, costUsdTotal } from '../observability/metrics.js';
import { env } from '../config/env.js';

export interface UsageRecord {
  requestId: string;
  apiKeyId: string;
  createdAt: Date;
  alias: string;
  provider?: string;
  model?: string;
  stream: boolean;
  cacheHit: boolean;
  fallbackUsed: boolean;
  attempts: number;
  status: string;
  httpStatus: number;
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  upstreamLatencyMs?: number;
  ttfbMs?: number;
  savedCostUsd?: number;
  costUsd?: number;
  attemptRecords: AttemptRecord[];
}

interface QueuedUsageRecord {
  record: UsageRecord;
  failures: number;
}

const eventQueue: QueuedUsageRecord[] = [];
const unknownPriceModels = new Set<string>();
let flushTimer: ReturnType<typeof setInterval> | null = null;
let prismaRef: PrismaClient | null = null;

export function initUsageRecorder(prisma: PrismaClient): void {
  prismaRef = prisma;
  flushTimer = setInterval(() => {
    void flush();
  }, env.USAGE_FLUSH_INTERVAL_MS);
  if (flushTimer.unref) flushTimer.unref();
}

export function enqueueUsage(record: UsageRecord): void {
  if (eventQueue.length >= env.USAGE_QUEUE_MAX) {
    eventQueue.shift();
    usageRowsDropped.inc();
  }
  eventQueue.push({ record, failures: 0 });
  usageQueueDepth.set(eventQueue.length);

  if (!record.cacheHit && record.inputTokens && record.provider) {
    tokensTotal.inc({ provider: record.provider, direction: 'input' }, record.inputTokens);
  }
  if (!record.cacheHit && record.outputTokens && record.provider) {
    tokensTotal.inc({ provider: record.provider, direction: 'output' }, record.outputTokens);
  }

  if (eventQueue.length >= env.USAGE_FLUSH_BATCH_SIZE) {
    void flush();
  }
}

async function flush(): Promise<void> {
  if (!prismaRef || eventQueue.length === 0) return;

  const queuedBatch = eventQueue.splice(0, env.USAGE_FLUSH_BATCH_SIZE);
  const batch = queuedBatch.map((queued) => queued.record);
  usageQueueDepth.set(eventQueue.length);

  try {
    const events = batch.map((r) => {
      const costUsd = r.costUsd ??
        (r.provider && r.model && r.inputTokens !== undefined && r.outputTokens !== undefined
          ? computeCost(r.provider, r.model, r.inputTokens, r.outputTokens)
          : null);

      if (r.provider && r.model && r.inputTokens !== undefined && r.outputTokens !== undefined && costUsd === null) {
        const modelKey = `${r.provider}:${r.model}`;
        if (!unknownPriceModels.has(modelKey)) {
          unknownPriceModels.add(modelKey);
          logger.warn({ msg: 'No configured price for model; cost remains null', provider: r.provider, model: r.model });
        }
      }

      return {
        requestId: r.requestId,
        apiKeyId: r.apiKeyId,
        createdAt: r.createdAt,
        alias: r.alias,
        provider: r.provider ?? null,
        model: r.model ?? null,
        stream: r.stream,
        cacheHit: r.cacheHit,
        fallbackUsed: r.fallbackUsed,
        attempts: r.attempts,
        status: r.status,
        httpStatus: r.httpStatus,
        errorCode: r.errorCode ?? null,
        inputTokens: r.inputTokens ?? null,
        outputTokens: r.outputTokens ?? null,
        costUsd: costUsd,
        savedCostUsd: r.savedCostUsd ?? 0,
        latencyMs: r.latencyMs,
        upstreamLatencyMs: r.upstreamLatencyMs ?? null,
        ttfbMs: r.ttfbMs ?? null,
      };
    });

    const attemptRows = batch.flatMap((r) =>
      r.attemptRecords.map((a, i) => ({
        requestId: r.requestId,
        attemptNo: i + 1,
        provider: a.provider,
        model: a.model,
        outcome: a.outcome,
        httpStatus: a.httpStatus ?? null,
        latencyMs: a.latencyMs,
        createdAt: r.createdAt,
      }))
    );

    await prismaRef.$transaction(async (tx) => {
      await tx.usageEvent.createMany({ data: events, skipDuplicates: true });
      if (attemptRows.length > 0) await tx.providerAttempt.createMany({ data: attemptRows });
      const keyIds = [...new Set(batch.map((record) => record.apiKeyId))];
      await Promise.all(keyIds.map((id) => tx.apiKey.updateMany({ where: { id }, data: { lastUsedAt: new Date() } })));
    });

    // Only count committed cost; a re-queued batch must not inflate metrics.
    for (const [index, record] of batch.entries()) {
      const cost = events[index]!.costUsd;
      if (typeof cost === 'number' && cost > 0 && record.provider) {
        costUsdTotal.inc({ provider: record.provider }, cost);
      }
    }
  } catch (err) {
    logger.error({ msg: 'Usage flush error', error: (err as Error).message });
    const retryable = queuedBatch
      .map((queued) => ({ ...queued, failures: queued.failures + 1 }))
      .filter((queued) => queued.failures <= 3);
    const dropped = queuedBatch.length - retryable.length;
    if (dropped > 0) {
      usageRowsDropped.inc(dropped);
      logger.error({ msg: 'Dropping usage rows after repeated write failures', count: dropped });
    }
    const toRestore = retryable.slice(0, Math.max(0, env.USAGE_QUEUE_MAX - eventQueue.length));
    eventQueue.unshift(...toRestore);
    usageQueueDepth.set(eventQueue.length);
  }
}

export async function flushAndShutdown(): Promise<void> {
  if (flushTimer) clearInterval(flushTimer);
  const deadline = Date.now() + 25_000;
  while (eventQueue.length > 0 && Date.now() < deadline) {
    await flush();
  }
  if (eventQueue.length > 0) logger.error({ msg: 'Usage rows left unflushed at shutdown', count: eventQueue.length });
}
