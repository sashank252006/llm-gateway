import type { Redis } from 'ioredis';
import type { ChatResponse, ChatChunk } from '../domain/types.js';
import { logger } from '../observability/logger.js';

const MAX_CACHE_SIZE_BYTES = 256 * 1024; // 256 KB

export interface CachedEntry {
  response: ChatResponse;
  provider: string;
  model: string;
}

export async function cacheGet(redis: Redis, key: string): Promise<CachedEntry | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedEntry;
  } catch (err) {
    logger.warn({ msg: 'Cache get error', error: (err as Error).message });
    // The caller records this as a skipped cache, not as a miss. A Redis outage
    // must not make cache-hit metrics look healthier than they are.
    throw err;
  }
}

export async function cacheSet(
  redis: Redis,
  key: string,
  entry: CachedEntry,
  ttlSeconds: number
): Promise<void> {
  try {
    const serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CACHE_SIZE_BYTES) {
      logger.debug({ msg: 'Cache entry too large, skipping', size: Buffer.byteLength(serialized, 'utf8') });
      return;
    }
    await redis.set(key, serialized, 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ msg: 'Cache set error', error: (err as Error).message });
  }
}

export async function* replayAsStream(entry: CachedEntry): AsyncGenerator<ChatChunk> {
  const id = entry.response.id;
  const created = entry.response.created;
  const model = entry.response.model;
  const content = entry.response.choices[0]?.message.content ?? '';
  const usage = entry.response.usage;
  const finish_reason = entry.response.choices[0]?.finish_reason ?? 'stop';

  // Role chunk
  yield {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };

  // Content chunk
  if (content) {
    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
  }

  // Final chunk with usage
  yield {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason }],
    usage,
  };
}
