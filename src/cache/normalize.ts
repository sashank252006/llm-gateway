import { createHash } from 'crypto';
import type { ChatRequest } from '../domain/types.js';

function canonicalJson(obj: unknown): string {
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .filter((k) => (obj as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`);
    return '{' + sorted.join(',') + '}';
  }
  return JSON.stringify(obj);
}

export function buildCacheKey(
  req: ChatRequest,
  keyId: string,
  alias: string,
  chainHash: string,
  defaultMaxTokens: number
): string {
  const normalized = {
    v: 1,
    keyId,
    alias,
    chainHash,
    messages: req.messages,
    temperature: req.temperature ?? 0,
    top_p: req.top_p,
    max_tokens: req.max_tokens ?? defaultMaxTokens,
    stop: Array.isArray(req.stop) ? [...req.stop].sort() : req.stop,
  };

  const hash = createHash('sha256').update(canonicalJson(normalized)).digest('hex');
  return `gw:v1:cache:${hash}`;
}

export function hashChain(
  chain: Array<{ provider: string; model: string; timeoutMs: number }>
): string {
  return createHash('sha256')
    .update(JSON.stringify(chain.map((t) => ({ p: t.provider, m: t.model }))))
    .digest('hex')
    .substring(0, 8);
}

