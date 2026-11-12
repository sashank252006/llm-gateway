import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'llm_gateway_node_' });

export const requestsTotal = new Counter({
  name: 'llm_gateway_requests_total',
  help: 'Total number of gateway requests',
  labelNames: ['alias', 'http_status', 'cache'] as const,
  registers: [registry],
});

export const requestDuration = new Histogram({
  name: 'llm_gateway_request_duration_seconds',
  help: 'Total gateway request duration',
  labelNames: ['alias', 'stream'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

export const overheadSeconds = new Histogram({
  name: 'llm_gateway_overhead_seconds',
  help: 'Gateway overhead (total latency minus upstream latency)',
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
});

export const upstreamDuration = new Histogram({
  name: 'llm_gateway_upstream_duration_seconds',
  help: 'Per-attempt upstream latency',
  labelNames: ['provider', 'outcome'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

export const cacheRequestsTotal = new Counter({
  name: 'llm_gateway_cache_requests_total',
  help: 'Cache hit/miss/skip counts',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const providerErrorsTotal = new Counter({
  name: 'llm_gateway_provider_errors_total',
  help: 'Provider errors by class',
  labelNames: ['provider', 'class'] as const,
  registers: [registry],
});

export const fallbacksTotal = new Counter({
  name: 'llm_gateway_fallbacks_total',
  help: 'Fallback events',
  labelNames: ['from', 'to'] as const,
  registers: [registry],
});

export const circuitState = new Gauge({
  name: 'llm_gateway_circuit_state',
  help: 'Circuit breaker state: 0=closed, 1=half-open, 2=open',
  labelNames: ['provider'] as const,
  registers: [registry],
});

export const rateLimitedTotal = new Counter({
  name: 'llm_gateway_rate_limited_total',
  help: 'Rate-limited requests',
  registers: [registry],
});

export const tokensTotal = new Counter({
  name: 'llm_gateway_tokens_total',
  help: 'Tokens processed',
  labelNames: ['provider', 'direction'] as const,
  registers: [registry],
});

export const costUsdTotal = new Counter({
  name: 'llm_gateway_cost_usd_total',
  help: 'Total cost in USD',
  labelNames: ['provider'] as const,
  registers: [registry],
});

export const usageQueueDepth = new Gauge({
  name: 'llm_gateway_usage_queue_depth',
  help: 'Current usage queue depth',
  registers: [registry],
});

export const usageRowsDropped = new Counter({
  name: 'llm_gateway_usage_rows_dropped_total',
  help: 'Usage rows dropped due to queue overflow',
  registers: [registry],
});

export const redisErrorsTotal = new Counter({
  name: 'llm_gateway_redis_errors_total',
  help: 'Redis errors',
  registers: [registry],
});
