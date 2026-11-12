import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const cacheHits = new Counter('gateway_cache_hits');
export const options = { scenarios: { cache: { executor: 'constant-arrival-rate', rate: 50, timeUnit: '1s', duration: '30s', preAllocatedVUs: 10, maxVUs: 50 } } };
const payload = JSON.stringify({ model: 'fast', temperature: 0, messages: [{ role: 'user', content: 'deterministic cache benchmark' }] });
const params = { headers: { Authorization: `Bearer ${__ENV.API_KEY}`, 'Content-Type': 'application/json' } };

export function setup() { http.post(`${__ENV.GATEWAY_URL}/v1/chat/completions`, payload, params); }
export default function () {
  const response = http.post(`${__ENV.GATEWAY_URL}/v1/chat/completions`, payload, params);
  if (response.headers['X-Gateway-Cache'] === 'HIT') cacheHits.add(1);
  check(response, { '200 cache response': r => r.status === 200, 'cache hit': r => r.headers['X-Gateway-Cache'] === 'HIT' });
}
