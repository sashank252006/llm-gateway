import type { ChatRequest } from '../domain/types.js';

export function isCacheable(
  req: ChatRequest,
  cacheEnabled: boolean,
  bypassHeader: boolean
): { cacheable: boolean; reason?: string } {
  if (!cacheEnabled) {
    return { cacheable: false, reason: 'cache_disabled' };
  }
  if (bypassHeader) {
    return { cacheable: false, reason: 'bypass_header' };
  }
  if (req.temperature !== 0) {
    return { cacheable: false, reason: 'temperature_nonzero' };
  }
  return { cacheable: true };
}

