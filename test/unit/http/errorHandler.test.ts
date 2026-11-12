import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../../src/http/middleware/errorHandler.js';

function response() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json, setHeader: vi.fn() } as any;
}

describe('errorHandler body parser errors', () => {
  it('returns 400 for malformed JSON', () => {
    const res = response();
    errorHandler(Object.assign(new Error('bad json'), { type: 'entity.parse.failed' }), { requestId: 'req_test', log: { error: vi.fn() } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('invalid_request');
  });

  it('returns 413 for a body over the limit', () => {
    const res = response();
    errorHandler(Object.assign(new Error('large'), { type: 'entity.too.large', status: 413 }), { requestId: 'req_test', log: { error: vi.fn() } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json.mock.calls[0][0].error.code).toBe('request_too_large');
  });
});
