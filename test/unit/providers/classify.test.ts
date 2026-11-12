import { describe, expect, it } from 'vitest';
import { classifyHttpError, classifyNetworkError, classifyTimeout } from '../../../src/providers/classify.js';

describe('provider error classification', () => {
  it('classifies timeouts and refused connections as retryable failures', () => {
    expect(classifyTimeout()).toMatchObject({ errorClass: 'timeout', retryable: true, fallbackable: true });
    expect(classifyNetworkError()).toMatchObject({ errorClass: 'network_error', retryable: true, fallbackable: true });
  });

  it('keeps provider 400 local to the request', () => {
    expect(classifyHttpError(400)).toMatchObject({ errorClass: 'http_4xx', retryable: false, fallbackable: false });
  });

  it('honours short Retry-After values for 429 retry timing', () => {
    expect(classifyHttpError(429, 2_000)).toMatchObject({ errorClass: 'http_429', retryable: true, retryAfterMs: 2_000 });
    expect(classifyHttpError(429, 12_000)).toMatchObject({ errorClass: 'http_429', retryable: false });
  });
});
