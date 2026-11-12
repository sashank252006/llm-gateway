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
  attemptRecords: AttemptRecord[];
}

const eventQueue: UsageRecord[] = [];
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
  eventQueue.push(record);
  usageQueueDepth.set(eventQueue.length);

  if (record.inputTokens && record.provider) {
    tokensTotal.inc({ provider: record.provider, direction: 'input' }, record.inputTokens);
  }
  if (record.outputTokens && record.provider) {
    tokensTotal.inc({ provider: record.provider, direction: 'output' }, record.outputTokens);
  }

  if (eventQueue.length >= env.USAGE_FLUSH_BATCH_SIZE) {
    void flush();
  }
}

async function flush(): Promise<void> {
  if (!prismaRef || eventQueue.length === 0) return;

  const batch = eventQueue.splice(0, env.USAGE_FLUSH_BATCH_SIZE);
  usageQueueDepth.set(eventQueue.length);

  try {
    const events = batch.map((r) => {
      const costUsd =
        r.provider && r.model && r.inputTokens !== undefined && r.outputTokens !== undefined
          ? computeCost(r.provider, r.model, r.inputTokens, r.outputTokens)
          : null;

      if (costUsd !== null && r.provider) {
        costUsdTotal.inc({ provider: r.provider }, costUsd);
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

    await prismaRef.usageEvent.createMany({ data: events, skipDuplicates: true });

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

    if (attemptRows.length > 0) {
      await prismaRef.providerAttempt.createMany({ data: attemptRows });
    }
  } catch (err) {
    logger.error({ msg: 'Usage flush error', error: (err as Error).message });
    const toRestore = batch.slice(0, Math.max(0, env.USAGE_QUEUE_MAX - eventQueue.length));
    eventQueue.unshift(...toRestore);
    usageQueueDepth.set(eventQueue.length);
  }
}

export async function flushAndShutdown(): Promise<void> {
  if (flushTimer) clearInterval(flushTimer);
  await flush();
}

