import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const info = vi.hoisted(() => vi.fn());
vi.mock('../../../src/observability/logger.js', () => ({ logger: { child: () => ({ info, error: vi.fn() }) } }));

import { requestIdMiddleware } from '../../../src/http/middleware/requestId.js';

describe('request completion logging', () => {
  it('records structured request metadata without prompt text', () => {
    const prompt = 'do-not-write-this-prompt-to-logs';
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      locals: { requestLog: { api_key_id: 'key-1', provider: 'openai', model: 'gpt-4o-mini', attempts: 1, fallback: false, input_tokens: 2, output_tokens: 3, cost_usd: 0.001, error_code: null } },
      setHeader: vi.fn(), getHeader: vi.fn(() => 'MISS'),
    });
    const request = { headers: {}, method: 'POST', path: '/v1/chat/completions', body: { model: 'fast', messages: [{ role: 'user', content: prompt }] } };
    requestIdMiddleware(request as any, response as any, vi.fn());
    response.emit('finish');
    const serialized = JSON.stringify(info.mock.calls[0]?.[0]);
    expect(serialized).not.toContain(prompt);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ api_key_id: 'key-1', provider: 'openai', attempts: 1 }));
  });
});
