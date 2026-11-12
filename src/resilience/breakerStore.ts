export type BreakerState = 'closed' | 'half-open' | 'open';

export interface BreakerRecord {
  state: BreakerState;
  failures: number;
  openedAt?: number;
  cooldownMs: number;
  probeInFlight: boolean;
}

export interface BreakerStore {
  get(provider: string): BreakerRecord;
  recordSuccess(provider: string): void;
  recordFailure(provider: string): void;
  isAllowed(provider: string): boolean;
  tryProbe(provider: string): boolean;
  releaseProbe(provider: string): void;
  cooldownRemainingMs(provider: string): number;
}

export class InMemoryBreakerStore implements BreakerStore {
  private records = new Map<string, BreakerRecord>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly baseCooldownMs = 30000,
    private readonly now: () => number = Date.now,
  ) {}

  private getOrCreate(provider: string): BreakerRecord {
    if (!this.records.has(provider)) {
      this.records.set(provider, {
        state: 'closed',
        failures: 0,
        cooldownMs: this.baseCooldownMs,
        probeInFlight: false,
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
    if (rec.openedAt !== undefined && this.now() - rec.openedAt >= rec.cooldownMs) {
      rec.state = 'half-open';
      return false; // must call tryProbe
    }
    return false;
  }

  tryProbe(provider: string): boolean {
    const rec = this.getOrCreate(provider);
    if (rec.state !== 'half-open' || rec.probeInFlight) return false;
    rec.probeInFlight = true;
    return true;
  }

  releaseProbe(provider: string): void {
    const rec = this.getOrCreate(provider);
    rec.probeInFlight = false;
  }

  cooldownRemainingMs(provider: string): number {
    const rec = this.getOrCreate(provider);
    if (rec.state !== 'open' || rec.openedAt === undefined) return 0;
    return Math.max(0, rec.cooldownMs - (this.now() - rec.openedAt));
  }

  recordSuccess(provider: string): void {
    const rec = this.getOrCreate(provider);
    rec.state = 'closed';
    rec.failures = 0;
    rec.cooldownMs = this.baseCooldownMs;
    rec.openedAt = undefined;
    rec.probeInFlight = false;
  }

  recordFailure(provider: string): void {
    const rec = this.getOrCreate(provider);
    if (rec.state === 'half-open' || rec.probeInFlight || rec.state === 'open') {
      // Probe failed: reopen with doubled cooldown (capped at 5 minutes)
      rec.cooldownMs = Math.min(rec.cooldownMs * 2, 300000);
      rec.openedAt = this.now();
      rec.state = 'open';
      rec.probeInFlight = false;
      return;
    }
    rec.failures += 1;
    if (rec.failures >= this.failureThreshold) {
      rec.state = 'open';
      rec.openedAt = this.now();
      rec.probeInFlight = false;
    }
  }
}
