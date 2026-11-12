import { describe, expect, it } from 'vitest';
import { InMemoryBreakerStore } from '../../../src/resilience/breakerStore.js';

describe('InMemoryBreakerStore', () => {
  it('permits exactly one half-open probe and closes after it succeeds', () => {
    let now = 0;
    const breaker = new InMemoryBreakerStore(2, 100, () => now);
    breaker.recordFailure('openai');
    breaker.recordFailure('openai');
    expect(breaker.get('openai').state).toBe('open');

    now = 100;
    expect(breaker.isAllowed('openai')).toBe(false);
    expect(breaker.tryProbe('openai')).toBe(true);
    expect(breaker.tryProbe('openai')).toBe(false);
    expect(breaker.get('openai').state).toBe('half-open');

    breaker.recordSuccess('openai');
    expect(breaker.isAllowed('openai')).toBe(true);
    expect(breaker.get('openai').failures).toBe(0);
  });

  it('does not open for a successful request after earlier failures', () => {
    const breaker = new InMemoryBreakerStore(2, 100);
    breaker.recordFailure('anthropic');
    breaker.recordSuccess('anthropic');
    expect(breaker.get('anthropic').state).toBe('closed');
    expect(breaker.get('anthropic').failures).toBe(0);
  });

  it('reopens a failed probe with an exponential cooldown', () => {
    let now = 0;
    const breaker = new InMemoryBreakerStore(1, 100, () => now);
    breaker.recordFailure('openai');
    now = 100;
    expect(breaker.isAllowed('openai')).toBe(false);
    expect(breaker.tryProbe('openai')).toBe(true);
    breaker.recordFailure('openai');
    expect(breaker.get('openai')).toMatchObject({ state: 'open', cooldownMs: 200, probeInFlight: false });
    expect(breaker.cooldownRemainingMs('openai')).toBe(200);
  });
});
