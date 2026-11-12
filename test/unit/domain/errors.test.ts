import { describe, it, expect } from 'vitest';
import { GatewayError, UpstreamError } from '../../../src/domain/errors.js';

describe('GatewayError', () => {
  it('maps rate_limit_exceeded to 429', () => {
    const err = new GatewayError('rate_limit_exceeded', 'Too many requests', { retryAfterSeconds: 3 });
    expect(err.httpStatus).toBe(429);
    expect(err.errorType).toBe('rate_limit_error');
    expect(err.retryAfterSeconds).toBe(3);
  });

  it('maps invalid_api_key to 401', () => {
    const err = new GatewayError('invalid_api_key', 'Bad key');
    expect(err.httpStatus).toBe(401);
    expect(err.errorType).toBe('authentication_error');
  });

  it('maps upstream_error to 502', () => {
    const err = new GatewayError('upstream_error', 'All failed');
    expect(err.httpStatus).toBe(502);
    expect(err.errorType).toBe('api_error');
  });

  it('maps all_providers_unavailable to 503', () => {
    const err = new GatewayError('all_providers_unavailable', 'Circuits open');
    expect(err.httpStatus).toBe(503);
  });
});

describe('UpstreamError', () => {
  it('timeout is retryable and fallbackable', () => {
    const err = new UpstreamError('timeout', true, true);
    expect(err.retryable).toBe(true);
    expect(err.fallbackable).toBe(true);
    expect(err.errorClass).toBe('timeout');
  });

  it('http_4xx (400) is not retryable or fallbackable', () => {
    const err = new UpstreamError('http_4xx', false, false, 400);
    expect(err.retryable).toBe(false);
    expect(err.fallbackable).toBe(false);
    expect(err.httpStatus).toBe(400);
  });

  it('http_5xx is retryable and fallbackable', () => {
    const err = new UpstreamError('http_5xx', true, true, 503);
    expect(err.retryable).toBe(true);
    expect(err.fallbackable).toBe(true);
  });
});

