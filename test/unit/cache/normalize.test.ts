import { describe, expect, it } from 'vitest';
import { buildCacheKey } from '../../../src/cache/normalize.js';
import { replayAsStream } from '../../../src/cache/cache.js';

const base = {
  model: 'fast',
  messages: [{ role: 'user' as const, content: 'hello' }],
  temperature: 0,
};

describe('cache normalization and streaming replay', () => {
  it('canonicalizes field order and isolates cache entries by API key', () => {
    const keyA = buildCacheKey({ ...base, stream: true, stream_options: { include_usage: true } }, 'key-a', 'fast', 'chain', 100);
    const keyB = buildCacheKey({ temperature: 0, messages: base.messages, model: 'fast' }, 'key-a', 'fast', 'chain', 100);
    const otherKey = buildCacheKey(base, 'key-b', 'fast', 'chain', 100);
    expect(keyA).toBe(keyB);
    expect(keyA).not.toBe(otherKey);
  });

  it('replays a cached response as role, content, and usage chunks', async () => {
    const chunks = [];
    for await (const chunk of replayAsStream({
      provider: 'openai', model: 'gpt-6-luna',
      response: {
        id: 'cached', object: 'chat.completion', created: 1, model: 'gpt-6-luna',
        choices: [{ index: 0, message: { role: 'assistant', content: 'cached response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
    })) chunks.push(chunk);
    expect(chunks).toHaveLength(3);
    expect(chunks[1]?.choices[0]?.delta.content).toBe('cached response');
    expect(chunks[2]?.usage).toMatchObject({ total_tokens: 3 });
  });
});
