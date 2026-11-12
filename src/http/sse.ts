import type { Response } from 'express';

export class SSEWriter {
  private res: Response;
  private committed = false;

  constructor(res: Response) {
    this.res = res;
  }

  start(): void {
    if (this.committed) return;
    this.committed = true;
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.flushHeaders();
  }

  async write(data: unknown, signal?: AbortSignal): Promise<void> {
    if (this.res.write(`data: ${JSON.stringify(data)}\n\n`)) return;
    await new Promise<void>((resolve, reject) => {
      const stall = setTimeout(() => reject(new Error('SSE client stopped reading')), 30_000);
      const cleanup = () => {
        clearTimeout(stall);
        this.res.removeListener('drain', drained);
        this.res.removeListener('close', closed);
        signal?.removeEventListener('abort', aborted);
      };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error('SSE response closed')); };
      const aborted = () => { cleanup(); reject(new Error('SSE write aborted')); };
      this.res.once('drain', drained);
      this.res.once('close', closed);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  done(): void {
    this.res.write('data: [DONE]\n\n');
    this.res.end();
  }

  error(err: { message: string; code: string; request_id: string }): void {
    this.res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
    this.res.end();
  }

  get isCommitted(): boolean {
    return this.committed;
  }
}
