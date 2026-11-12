import { describe, expect, it, vi } from 'vitest';
import { GatewayError } from '../../../src/domain/errors.js';
import { evictKey, lookupKey } from '../../../src/keys/index.js';

const row = {
  id: '00000000-0000-0000-0000-000000000001', name: 'test', rateLimitRpm: 60,
  rateLimitBurst: 20, maxOutputTokensCap: 4096, cacheEnabled: true, revokedAt: null,
};
const prisma = (findUnique: ReturnType<typeof vi.fn>) => ({ apiKey: { findUnique } }) as any;

describe('API-key lookup cache', () => {
  it('does not negative-cache a missing key', async () => {
    const hash = 'missing-then-created';
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    await expect(lookupKey(hash, prisma(findUnique))).rejects.toBeInstanceOf(GatewayError);
    await expect(lookupKey(hash, prisma(findUnique))).resolves.toMatchObject({ id: row.id });
    evictKey(hash);
  });

  it('serves a known key during a bounded database outage', async () => {
    const hash = 'known-key-outage';
    const findUnique = vi.fn().mockResolvedValueOnce(row).mockRejectedValueOnce(new Error('database unavailable'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await expect(lookupKey(hash, prisma(findUnique))).resolves.toMatchObject({ id: row.id });
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    await expect(lookupKey(hash, prisma(findUnique))).resolves.toMatchObject({ id: row.id });
    vi.useRealTimers();
    evictKey(hash); // force the next test run to be isolated
  });
});
