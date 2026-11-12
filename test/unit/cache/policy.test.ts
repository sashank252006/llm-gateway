import { describe, it, expect } from 'vitest';
import { isCacheable } from '../../../src/cache/policy.js';

describe('isCacheable', () => {
  it('caches when temperature is explicitly 0', () => {
    const req = { model: 'fast', messages: [{ role: 'user' as const, content: 'hi' }], temperature: 0 };
    expect(isCacheable(req, true, false).cacheable).toBe(true);
  });

  it('does not cache when temperature is unset (defaults non-deterministic)', () => {
    const req = { model: 'fast', messages: [{ role: 'user' as const, content: 'hi' }] };
    expect(isCacheable(req, true, false).cacheable).toBe(false);
    expect(isCacheable(req, true, false).reason).toBe('temperature_nonzero');
  });

  it('does not cache when temperature > 0', () => {
    const req = { model: 'fast', messages: [{ role: 'user' as const, content: 'hi' }], temperature: 0.7 };
    expect(isCacheable(req, true, false).cacheable).toBe(false);
  });

  it('does not cache when cache disabled on key', () => {
    const req = { model: 'fast', messages: [{ role: 'user' as const, content: 'hi' }], temperature: 0 };
    expect(isCacheable(req, false, false).cacheable).toBe(false);
    expect(isCacheable(req, false, false).reason).toBe('cache_disabled');
  });

  it('does not cache when x-gateway-cache: bypass header present', () => {
    const req = { model: 'fast', messages: [{ role: 'user' as const, content: 'hi' }], temperature: 0 };
    expect(isCacheable(req, true, true).cacheable).toBe(false);
    expect(isCacheable(req, true, true).reason).toBe('bypass_header');
  });
});

