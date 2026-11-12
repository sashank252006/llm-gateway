import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/app.js';

const key = {
  id: '00000000-0000-0000-0000-000000000001', name: 'test', rateLimitRpm: 60,
  rateLimitBurst: 20, maxOutputTokensCap: 4096, cacheEnabled: true, revokedAt: null,
};

function app() {
  const prisma = {
    apiKey: { findUnique: vi.fn().mockResolvedValue(key) },
    $queryRaw: vi.fn().mockResolvedValue([{ value: 1 }]),
  } as any;
  // Redis intentionally lacks methods. The data-plane router must fall back to
  // its in-memory rate limiter without turning malformed JSON into a 500.
  return createApp({ prisma, redis: {} as any });
}

// supertest binds a loopback port; run this in CI or a normal local shell.
const routeIntegration = process.env.RUN_ROUTE_INTEGRATION === '1';
describe.runIf(routeIntegration)('HTTP route integration with mocked infrastructure', () => {
  it('rejects malformed JSON after authentication with the OpenAI-style 400 envelope', async () => {
    const response = await request(app())
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer lgw_live_valid')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it('requires an API key to list models', async () => {
    const response = await request(app()).get('/v1/models');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_api_key');
  });

  it('rejects an unsupported chat parameter with its parameter name', async () => {
    const response = await request(app())
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer lgw_live_valid')
      .send({ model: 'fast', messages: [{ role: 'user', content: 'hello' }], tools: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'unsupported_parameter', param: 'tools' });
  });
});
