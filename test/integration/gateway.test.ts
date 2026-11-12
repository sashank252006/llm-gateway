import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { createFakeProvider } from '../../src/fakeProvider.js';

const integration = process.env.RUN_INTEGRATION === '1';

describe.runIf(integration)('gateway request paths', () => {
  let provider: Server;
  let providerUrl: string;
  let prisma: PrismaClient;
  let redis: Redis;
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let createKey: (name: string, overrides?: { rateLimitRpm?: number; rateLimitBurst?: number }) => Promise<string>;
  const createdKeyIds: string[] = [];

  async function control(name: 'openai' | 'anthropic', behavior: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${providerUrl}/__control/${name}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(behavior),
    });
    expect(response.ok).toBe(true);
  }

  beforeAll(async () => {
    provider = createFakeProvider().listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Fake provider did not bind a TCP port');
    providerUrl = `http://127.0.0.1:${address.port}`;

    process.env.OPENAI_BASE_URL = `${providerUrl}/v1`;
    process.env.ANTHROPIC_BASE_URL = providerUrl;
    vi.resetModules();
    const [{ createApp }, infra, keys] = await Promise.all([
      import('../../src/app.js'), import('../../src/infra/prisma.js'), import('../../src/keys/index.js'),
    ]);
    prisma = infra.getPrisma();
    redis = (await import('../../src/infra/redis.js')).getRedis();
    await redis.connect();
    app = createApp({ prisma, redis });
    createKey = async (name, overrides = {}) => {
      const plainKey = keys.generateKey();
      const key = await prisma.apiKey.create({
        data: {
          name, keyPrefix: keys.getKeyPrefix(plainKey), keyHash: keys.hashKey(plainKey),
          rateLimitRpm: overrides.rateLimitRpm ?? 60,
          rateLimitBurst: overrides.rateLimitBurst ?? 20,
          maxOutputTokensCap: 4096,
        },
      });
      createdKeyIds.push(key.id);
      return plainKey;
    };
  });

  beforeEach(async () => {
    await control('openai', { statusCode: 200, latencyMs: 0, dieAfterChunks: 0, hang: false });
    await control('anthropic', { statusCode: 200, latencyMs: 0, dieAfterChunks: 0, hang: false });
  });

  afterAll(async () => {
    if (createdKeyIds.length) await prisma.apiKey.deleteMany({ where: { id: { in: createdKeyIds } } });
    await redis.disconnect();
    await prisma.$disconnect();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it('authenticates, calls the provider, and serves the second deterministic request from cache', async () => {
    const key = await createKey(`cache-${Date.now()}`);
    const body = { model: 'fast', temperature: 0, messages: [{ role: 'user', content: `cache-${Date.now()}` }] };
    const first = await request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`).send(body);
    expect(first.status).toBe(200);
    expect(first.headers['x-gateway-cache']).toBe('MISS');

    await control('openai', { statusCode: 503 });
    const second = await request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`).send(body);
    expect(second.status).toBe(200);
    expect(second.headers['x-gateway-cache']).toBe('HIT');
  });

  it('falls back when the first provider fails and returns structured client errors', async () => {
    const key = await createKey(`fallback-${Date.now()}`);
    await control('openai', { statusCode: 503 });
    const fallback = await request(app)
      .post('/v1/chat/completions').set('Authorization', `Bearer ${key}`)
      .set('x-gateway-cache', 'bypass')
      .send({ model: 'fast', messages: [{ role: 'user', content: 'fallback' }] });
    expect(fallback.status).toBe(200);
    expect(fallback.headers['x-gateway-provider']).toBe('anthropic');
    expect(fallback.headers['x-gateway-fallback']).toBe('true');

    const invalidModel = await request(app)
      .post('/v1/chat/completions').set('Authorization', `Bearer ${key}`)
      .send({ model: 'does-not-exist', messages: [{ role: 'user', content: 'nope' }] });
    expect(invalidModel.status).toBe(404);
    expect(invalidModel.body.error.code).toBe('model_not_found');
  });

  it('enforces authentication, body size, and rate limits', async () => {
    const unauthorized = await request(app).post('/v1/chat/completions').send({ model: 'fast', messages: [{ role: 'user', content: 'no key' }] });
    expect(unauthorized.status).toBe(401);

    const key = await createKey(`limits-${Date.now()}`, { rateLimitRpm: 1, rateLimitBurst: 1 });
    const first = await request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`).send({ model: 'fast', messages: [{ role: 'user', content: 'first' }] });
    expect(first.status).toBe(200);
    const limited = await request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`).send({ model: 'fast', messages: [{ role: 'user', content: 'second' }] });
    expect(limited.status).toBe(429);

    const largeKey = await createKey(`large-${Date.now()}`);
    const tooLarge = await request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${largeKey}`).send({ model: 'fast', messages: [{ role: 'user', content: 'x'.repeat(1_100_000) }] });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error.code).toBe('request_too_large');
  });
});
