import { randomBytes, createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import type { PrismaClient } from '@prisma/client';
import type { ApiKeyContext } from '../domain/types.js';
import { GatewayError } from '../domain/errors.js';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';

export function generateKey(): string {
  const random = randomBytes(32).toString('base64url');
  return `lgw_live_${random}`;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function getKeyPrefix(key: string): string {
  return key.substring(0, 12);
}

const keyCache = new LRUCache<string, ApiKeyContext | 'revoked' | 'not_found'>({
  max: env.AUTH_LRU_MAX,
  ttl: env.AUTH_LRU_TTL_MS,
});

export async function lookupKey(
  keyHash: string,
  prisma: PrismaClient
): Promise<ApiKeyContext> {
  const cached = keyCache.get(keyHash);

  if (cached === 'revoked' || cached === 'not_found') {
    throw new GatewayError('invalid_api_key', 'Invalid or revoked API key');
  }
  if (cached) {
    return cached;
  }

  let row: {
    id: string;
    name: string;
    rateLimitRpm: number;
    rateLimitBurst: number;
    maxOutputTokensCap: number;
    cacheEnabled: boolean;
    revokedAt: Date | null;
  } | null;

  try {
    row = await prisma.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        name: true,
        rateLimitRpm: true,
        rateLimitBurst: true,
        maxOutputTokensCap: true,
        cacheEnabled: true,
        revokedAt: true,
      },
    });
  } catch (err) {
    logger.warn({ msg: 'DB lookup failed for key', error: (err as Error).message });
    throw new GatewayError('auth_unavailable', 'Auth service temporarily unavailable');
  }

  if (!row) {
    keyCache.set(keyHash, 'not_found');
    throw new GatewayError('invalid_api_key', 'Invalid or revoked API key');
  }

  if (row.revokedAt !== null) {
    keyCache.set(keyHash, 'revoked');
    throw new GatewayError('invalid_api_key', 'Invalid or revoked API key');
  }

  const context: ApiKeyContext = {
    id: row.id,
    name: row.name,
    rateLimitRpm: row.rateLimitRpm,
    rateLimitBurst: row.rateLimitBurst,
    maxOutputTokensCap: row.maxOutputTokensCap,
    cacheEnabled: row.cacheEnabled,
  };

  keyCache.set(keyHash, context);
  return context;
}

export function evictKey(keyHash: string): void {
  keyCache.delete(keyHash);
}

