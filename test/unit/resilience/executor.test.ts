import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, UpstreamError } from '../../../src/domain/errors.js';
import { InMemoryBreakerStore } from '../../../src/resilience/breakerStore.js';

const adapter = vi.hoisted(() => ({ complete: vi.fn(), stream: vi.fn(), name: 'fake' }));
vi.mock('../../../src/providers/registry.js', () => ({ getAdapter: () => adapter }));

import { executeWithResilience } from '../../../src/resilience/executor.js';

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
});
