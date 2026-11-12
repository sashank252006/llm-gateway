import http from 'k6/http';
import { check } from 'k6';

export const options = { scenarios: { overhead: { executor: 'constant-arrival-rate', rate: 50, timeUnit: '1s', duration: '30s', preAllocatedVUs: 10, maxVUs: 50 } } };
const params = { headers: { Authorization: `Bearer ${__ENV.API_KEY}`, 'Content-Type': 'application/json', 'x-gateway-cache': 'bypass' } };
export default function () {
  const response = http.post(`${__ENV.GATEWAY_URL}/v1/chat/completions`, JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'overhead benchmark' }] }), params);
  check(response, { 'successful upstream response': r => r.status === 200 });
}
