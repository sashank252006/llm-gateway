import { circuitState } from '../observability/metrics.js';
import { env } from '../config/env.js';

export type BreakerState = 'closed' | 'half-open' | 'open';

export interface BreakerRecord {
  state: BreakerState;
  failures: number;
  openedAt?: number;
  cooldownMs: number;
}

export class InMemoryBreakerStore {
  private records = new Map<string, BreakerRecord>();
  private failureThreshold: number;
  private baseCooldownMs: number;

  constructor(failureThreshold = 5, baseCooldownMs = 30000) {
    this.failureThreshold = failureThreshold;
    this.baseCooldownMs = baseCooldownMs;
  }

  private getOrCreate(provider: string): BreakerRecord {
    if (!this.records.has(provider)) {
      this.records.set(provider, {
        state: 'closed',
        failures: 0,
        cooldownMs: this.baseCooldownMs,
      });
    }
    return this.records.get(provider)!;
  }

  get(provider: string): BreakerRecord {
    return this.getOrCreate(provider);
  }

  isAllowed(provider: string): boolean {
    const rec = this.getOrCreate(provider);
    if (rec.state === 'closed') return true;
    if (rec.state === 'half-open') return false;
    // open: check if cooldown elapsed → transition to half-open
    if (rec.openedAt && Date.now() - rec.openedAt >= rec.cooldownMs) {
      rec.state = 'half-open';
      return false;
    }
    return false;
  }

  tryProbe(provider: string): boolean {
    const rec = this.getOrCreate(provider);
    if (rec.state !== 'half-open') return false;
    rec.state = 'open'; // lock to prevent concurrent probes
    return true;
  }

  recordSuccess(provider: string): void {
    const rec = this.getOrCreate(provider);
    rec.state = 'closed';
    rec.failures = 0;
    rec.cooldownMs = this.baseCooldownMs;
    rec.openedAt = undefined;
  }

  recordFailure(provider: string): void {
    const rec = this.getOrCreate(provider);
    if (rec.state === 'open') {
      rec.cooldownMs = Math.min(rec.cooldownMs * 2, 300_000);
      rec.openedAt = Date.now();
    } else {
      rec.failures += 1;
      if (rec.failures >= this.failureThreshold) {
        rec.state = 'open';
        rec.openedAt = Date.now();
      }
    }
  }
}

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

