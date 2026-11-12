import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SSEWriter } from '../../../src/http/sse.js';

function response(write: ReturnType<typeof vi.fn>) {
  return Object.assign(new EventEmitter(), {
    setHeader: vi.fn(), flushHeaders: vi.fn(), write, end: vi.fn(),
  });
}

describe('SSEWriter', () => {
  it('waits for drain when the client applies backpressure', async () => {
    const write = vi.fn().mockReturnValue(false);
    const res = response(write);
    const writer = new SSEWriter(res as any);
    writer.start();
    const pending = writer.write({ chunk: 'payload' });
    expect(write).toHaveBeenCalledOnce();
    res.emit('drain');
    await expect(pending).resolves.toBeUndefined();
  });

  it('stops waiting when the client disconnects', async () => {
    const res = response(vi.fn().mockReturnValue(false));
    const writer = new SSEWriter(res as any);
    const pending = writer.write({ chunk: 'payload' });
    res.emit('close');
    await expect(pending).rejects.toThrow('closed');
  });
});
