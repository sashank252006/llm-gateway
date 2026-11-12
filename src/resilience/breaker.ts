import { env } from '../config/env.js';
import { circuitState } from '../observability/metrics.js';
import { InMemoryBreakerStore } from './breakerStore.js';

export { InMemoryBreakerStore } from './breakerStore.js';

export const breakerStore = new InMemoryBreakerStore(
  env.BREAKER_FAILURE_THRESHOLD,
  env.BREAKER_COOLDOWN_MS
);

function updateMetric(provider: string): void {
  const rec = breakerStore.get(provider);
  const stateNum = rec.state === 'closed' ? 0 : rec.state === 'half-open' ? 1 : 2;
  circuitState.set({ provider }, stateNum);
}

export function isBreakerAllowed(provider: string): boolean {
  const allowed = breakerStore.isAllowed(provider);
  updateMetric(provider);
  return allowed;
}

export function tryBreakerProbe(provider: string): boolean {
  const result = breakerStore.tryProbe(provider);
  updateMetric(provider);
  return result;
}

export function recordBreakerSuccess(provider: string): void {
  breakerStore.recordSuccess(provider);
  updateMetric(provider);
}

export function recordBreakerFailure(provider: string): void {
  breakerStore.recordFailure(provider);
  updateMetric(provider);
}

export function breakerRetryAfterSeconds(provider: string): number | undefined {
  const remainingMs = breakerStore.cooldownRemainingMs(provider);
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : undefined;
}
