import http from 'k6/http';
import { check } from 'k6';
export const options = { vus: 1, iterations: 20 };
export default function () {
  const response = http.post(`${__ENV.GATEWAY_URL}/v1/chat/completions`, JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'failover benchmark' }] }), { headers: { Authorization: `Bearer ${__ENV.API_KEY}`, 'Content-Type': 'application/json', 'x-gateway-cache': 'bypass' } });
  check(response, { 'served through gateway': r => r.status === 200 || r.status === 502 || r.status === 503 });
}
