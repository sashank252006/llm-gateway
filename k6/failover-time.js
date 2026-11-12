import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const failoverMs = new Trend('gateway_failover_ms');
export const options = { vus: 1, iterations: 20 };
const params = { headers: { Authorization: `Bearer ${__ENV.API_KEY}`, 'Content-Type': 'application/json', 'x-gateway-cache': 'bypass' } };

export function setup() {
  if (!__ENV.FAKE_PROVIDER_URL) throw new Error('FAKE_PROVIDER_URL is required');
  http.post(`${__ENV.FAKE_PROVIDER_URL}/__control/openai`, JSON.stringify({ statusCode: 503, hang: false }), { headers: { 'Content-Type': 'application/json' } });
}
export default function () {
  const started = Date.now();
  const response = http.post(`${__ENV.GATEWAY_URL}/v1/chat/completions`, JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'failover benchmark' }] }), params);
  if (response.status === 200 && response.headers['X-Gateway-Fallback'] === 'true') failoverMs.add(Date.now() - started);
  check(response, { 'fallback served successfully': r => r.status === 200 && r.headers['X-Gateway-Fallback'] === 'true' });
}
export function teardown() { http.post(`${__ENV.FAKE_PROVIDER_URL}/__control/openai`, JSON.stringify({ statusCode: 200, hang: false }), { headers: { 'Content-Type': 'application/json' } }); }
