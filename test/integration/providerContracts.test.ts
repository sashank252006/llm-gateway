import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createFakeProvider } from '../../src/fakeProvider.js';

const integration = process.env.RUN_INTEGRATION === '1';
const request = { model: 'fast', messages: [{ role: 'user' as const, content: 'hello' }], max_tokens: 32 };
const context = () => ({ requestId: 'req_provider_contract', signal: new AbortController().signal });

describe.runIf(integration)('provider adapter contracts', () => {
  let server: Server;
  let baseUrl: string;
  let OpenAIAdapter: typeof import('../../src/providers/openai.js').OpenAIAdapter;
  let AnthropicAdapter: typeof import('../../src/providers/anthropic.js').AnthropicAdapter;

  async function control(provider: 'openai' | 'anthropic', behavior: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${baseUrl}/__control/${provider}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(behavior),
    });
    expect(response.ok).toBe(true);
  }

  beforeAll(async () => {
    server = createFakeProvider().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fake provider did not bind a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    process.env.OPENAI_BASE_URL = `${baseUrl}/v1`;
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    vi.resetModules();
    ({ OpenAIAdapter } = await import('../../src/providers/openai.js'));
    ({ AnthropicAdapter } = await import('../../src/providers/anthropic.js'));
  });

  beforeEach(async () => {
    await control('openai', { statusCode: 200, latencyMs: 0, dieAfterChunks: 0, hang: false });
    await control('anthropic', { statusCode: 200, latencyMs: 0, dieAfterChunks: 0, hang: false });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it('translates complete and streaming OpenAI responses into the canonical format', async () => {
    const adapter = new OpenAIAdapter();
    const target = { provider: 'openai' as const, model: 'gpt-6-luna', timeoutMs: 1_000 };
    await expect(adapter.complete(request, target, context())).resolves.toMatchObject({ response: { choices: [{ message: { content: 'fake response' } }] } });

    const chunks = [];
    for await (const chunk of adapter.stream(request, target, context())) chunks.push(chunk);
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.content === 'fake response')).toBe(true);
    expect(chunks.at(-1)?.usage).toMatchObject({ prompt_tokens: 2, completion_tokens: 2 });
  });

  it('translates complete and streaming Anthropic responses into the canonical format', async () => {
    const adapter = new AnthropicAdapter();
    const target = { provider: 'anthropic' as const, model: 'claude-haiku-5-5', timeoutMs: 1_000 };
    await expect(adapter.complete(request, target, context())).resolves.toMatchObject({ response: { choices: [{ message: { content: 'fake response' } }] } });

    const chunks = [];
    for await (const chunk of adapter.stream(request, target, context())) chunks.push(chunk);
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.content === 'fake response')).toBe(true);
    expect(chunks.at(-1)?.usage).toMatchObject({ prompt_tokens: 2, completion_tokens: 2 });
  });

  it('classifies provider 5xx responses as retryable upstream failures', async () => {
    await control('openai', { statusCode: 503 });
    const adapter = new OpenAIAdapter();
    const target = { provider: 'openai' as const, model: 'gpt-6-luna', timeoutMs: 1_000 };
    await expect(adapter.complete(request, target, context())).rejects.toMatchObject({ errorClass: 'http_5xx', retryable: true, fallbackable: true, httpStatus: 503 });
  });
});
