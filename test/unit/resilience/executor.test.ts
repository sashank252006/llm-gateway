import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, UpstreamError } from '../../../src/domain/errors.js';
import { InMemoryBreakerStore } from '../../../src/resilience/breakerStore.js';

const adapter = vi.hoisted(() => ({ complete: vi.fn(), stream: vi.fn(), name: 'fake' }));
vi.mock('../../../src/providers/registry.js', () => ({ getAdapter: () => adapter }));

import { executeWithResilience, streamWithResilience } from '../../../src/resilience/executor.js';

const request = { model: 'fast', messages: [{ role: 'user' as const, content: 'hello' }] };
const targets = [
  { provider: 'openai' as const, model: 'one', timeoutMs: 100 },
  { provider: 'anthropic' as const, model: 'two', timeoutMs: 100 },
];
const context = () => ({ requestId: 'req_executor', signal: new AbortController().signal });
const success = { response: { id: 'id', object: 'chat.completion' as const, created: 0, model: 'one', choices: [{ index: 0, message: { role: 'assistant' as const, content: 'ok' }, finish_reason: 'stop' as const }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

describe('executeWithResilience', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries a transient failure then succeeds', async () => {
    adapter.complete.mockRejectedValueOnce(new UpstreamError('network_error', true, true)).mockResolvedValueOnce(success);
    const result = await executeWithResilience(request, [targets[0]!], context(), new InMemoryBreakerStore());
    expect(result.attempts).toHaveLength(2);
    expect(adapter.complete).toHaveBeenCalledTimes(2);
  });

  it('stops on a provider 400 instead of opening the breaker or falling back', async () => {
    adapter.complete.mockRejectedValue(new UpstreamError('http_4xx', false, false, 400));
    const breaker = new InMemoryBreakerStore();
    await expect(executeWithResilience(request, targets, context(), breaker)).rejects.toMatchObject({ code: 'invalid_request' } satisfies Partial<GatewayError>);
    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(breaker.get('openai').state).toBe('closed');
  });

  it('attaches failed attempts when every provider fails', async () => {
    adapter.complete.mockRejectedValue(new UpstreamError('http_5xx', false, true, 503));
    try {
      await executeWithResilience(request, targets, context(), new InMemoryBreakerStore());
      throw new Error('expected gateway error');
    } catch (error) {
      expect(error).toMatchObject({ code: 'upstream_error' });
      expect((error as GatewayError).attempts).toHaveLength(2);
    }
  });

  it('falls back after the configured transient retries are exhausted', async () => {
    adapter.complete
      .mockRejectedValueOnce(new UpstreamError('timeout', true, true))
      .mockRejectedValueOnce(new UpstreamError('timeout', true, true))
      .mockRejectedValueOnce(new UpstreamError('timeout', true, true))
      .mockResolvedValueOnce(success);
    const result = await executeWithResilience(request, targets, context(), new InMemoryBreakerStore());
    expect(result.provider).toBe('anthropic');
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts).toHaveLength(4);
  });

  it('falls back on provider-auth failures without retrying the failed provider', async () => {
    adapter.complete
      .mockRejectedValueOnce(new UpstreamError('http_4xx', false, true, 401))
      .mockResolvedValueOnce(success);
    const result = await executeWithResilience(request, targets, context(), new InMemoryBreakerStore());
    expect(result.provider).toBe('anthropic');
    expect(adapter.complete).toHaveBeenCalledTimes(2);
  });

  it('returns a 503 with a cooldown when every circuit is open', async () => {
    const breaker = new InMemoryBreakerStore(1, 100);
    breaker.recordFailure('openai');
    breaker.recordFailure('anthropic');
    await expect(executeWithResilience(request, targets, context(), breaker)).rejects.toMatchObject({
      code: 'all_providers_unavailable', httpStatus: 503, retryAfterSeconds: 1,
    } satisfies Partial<GatewayError>);
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('returns client_aborted immediately when its caller has disconnected', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(executeWithResilience(request, targets, { requestId: 'req_abort', signal: abort.signal }, new InMemoryBreakerStore())).rejects.toMatchObject({ code: 'client_aborted' });
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('never falls back after a streamed response commits', async () => {
    adapter.stream.mockImplementationOnce(async function* () {
      yield { id: 'id', object: 'chat.completion.chunk', created: 0, model: 'one', choices: [{ index: 0, delta: { content: 'A1' }, finish_reason: null }] };
      throw new UpstreamError('network_error', true, true);
    });
    const stream = streamWithResilience(request, targets, context(), new InMemoryBreakerStore());
    await expect(stream.next()).resolves.toMatchObject({ value: { provider: 'openai' } });
    await expect(stream.next()).rejects.toMatchObject({ code: 'upstream_error' });
    expect(adapter.stream).toHaveBeenCalledTimes(1);
  });

  it('releases a failed half-open probe that returns a provider 400', async () => {
    let now = 0;
    const breaker = new InMemoryBreakerStore(1, 100, () => now);
    breaker.recordFailure('openai');
    now = 100;
    adapter.complete.mockRejectedValue(new UpstreamError('http_4xx', false, false, 400));
    await expect(executeWithResilience(request, [targets[0]!], context(), breaker)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(breaker.tryProbe('openai')).toBe(true);
  });
});
