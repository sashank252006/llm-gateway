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

  write(data: unknown): boolean {
    return this.res.write(`data: ${JSON.stringify(data)}\n\n`);
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

