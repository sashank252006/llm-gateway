import { UpstreamError } from '../domain/errors.js';

export function classifyHttpError(status: number, retryAfterMs?: number): UpstreamError {
  if (status >= 500) {
    return new UpstreamError('http_5xx', true, true, status);
  }
  if (status === 429) {
    // Only retry if retry-after is short (< 10s)
    const shortRetry = retryAfterMs !== undefined && retryAfterMs < 10000;
    return new UpstreamError('http_429', shortRetry, true, status, retryAfterMs);
  }
  if (status === 401 || status === 403) {
    // Provider key is wrong - fallback but do not retry
    return new UpstreamError('http_4xx', false, true, status);
  }
  // 400 and other 4xx - do not retry, do not fallback
  return new UpstreamError('http_4xx', false, false, status);
}

export function classifyNetworkError(): UpstreamError {
  return new UpstreamError('network_error', true, true);
}

export function classifyTimeout(): UpstreamError {
  return new UpstreamError('timeout', true, true);
}
