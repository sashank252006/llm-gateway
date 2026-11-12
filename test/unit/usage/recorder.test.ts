import { afterEach, describe, expect, it, vi } from 'vitest';
import { enqueueUsage, flushAndShutdown, flushPendingUsage, initUsageRecorder } from '../../../src/usage/recorder.js';

const baseRecord = {
  requestId: 'req-recorder', apiKeyId: '00000000-0000-0000-0000-000000000001', createdAt: new Date(), alias: 'fast',
  provider: 'openai', model: 'gpt-4o-mini', stream: false, cacheHit: false, fallbackUsed: false,
  attempts: 1, status: 'ok', httpStatus: 200, inputTokens: 10, outputTokens: 5, latencyMs: 20, attemptRecords: [],
};

function prismaMock(transaction: ReturnType<typeof vi.fn>) {
  return { $transaction: transaction } as any;
}

describe('usage recorder', () => {
  afterEach(async () => { await flushAndShutdown(); });

  it('writes usage and provider attempts in one transaction', async () => {
    const usageEvent = { createMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const providerAttempt = { createMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const apiKey = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const transaction = vi.fn(async (callback) => callback({ usageEvent, providerAttempt, apiKey }));
    initUsageRecorder(prismaMock(transaction));
    enqueueUsage({ ...baseRecord, attemptRecords: [{ attemptNo: 1, provider: 'openai', model: 'gpt-4o-mini', outcome: 'success', latencyMs: 12 }] });
    await flushPendingUsage();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(usageEvent.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(providerAttempt.createMany).toHaveBeenCalledTimes(1);
    expect(apiKey.updateMany).toHaveBeenCalledTimes(1);
  });

  it('keeps transient database failures queued for a later flush', async () => {
    const transaction = vi.fn().mockRejectedValueOnce(new Error('connection lost'));
    initUsageRecorder(prismaMock(transaction));
    enqueueUsage({ ...baseRecord, requestId: 'req-transient' });
    await flushPendingUsage();
    const usageEvent = { createMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const providerAttempt = { createMany: vi.fn().mockResolvedValue({ count: 0 }) };
    const apiKey = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    transaction.mockImplementationOnce(async (callback) => callback({ usageEvent, providerAttempt, apiKey }));
    await flushPendingUsage();
    expect(usageEvent.createMany).toHaveBeenCalledTimes(1);
  });
});
