export type BreakerState = 'closed' | 'half-open' | 'open';

export interface BreakerRecord {
  state: BreakerState;
  failures: number;
  openedAt?: number;
  cooldownMs: number;
}

export interface BreakerStore {
  get(provider: string): BreakerRecord;
  recordSuccess(provider: string): void;
  recordFailure(provider: string): void;
  isAllowed(provider: string): boolean;
  tryProbe(provider: string): boolean;
}

export class InMemoryBreakerStore implements BreakerStore {
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
    if (rec.state === 'half-open') return false; // probe only via tryProbe
    // open: check if cooldown elapsed
    if (rec.openedAt && Date.now() - rec.openedAt >= rec.cooldownMs) {
      rec.state = 'half-open';
      return false; // must call tryProbe
    }
    return false;
  }

  tryProbe(provider: string): boolean {
    const rec = this.getOrCreate(provider);
    if (rec.state !== 'half-open') return false;
    // Allow exactly one probe
    rec.state = 'open'; // temporarily lock to prevent concurrent probes
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
    rec.failures += 1;
    if (rec.state === 'open') {
      // Probe failed: reopen with doubled cooldown (capped at 5 minutes)
      rec.cooldownMs = Math.min(rec.cooldownMs * 2, 300000);
      rec.openedAt = Date.now();
    } else if (rec.failures >= this.failureThreshold) {
      rec.state = 'open';
      rec.openedAt = Date.now();
    }
  }
}
