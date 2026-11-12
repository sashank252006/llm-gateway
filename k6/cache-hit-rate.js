import http from 'k6/http';
import { check } from 'k6';
export const options = { vus: 10, duration: '30s' };
export default function () {
  const response = http.post(`${__ENV.GATEWAY_URL}/v1/chat/completions`, JSON.stringify({ model: 'fast', temperature: 0, messages: [{ role: 'user', content: 'deterministic cache benchmark' }] }), { headers: { Authorization: `Bearer ${__ENV.API_KEY}`, 'Content-Type': 'application/json' } });
  check(response, { '200 response': r => r.status === 200 });
}
