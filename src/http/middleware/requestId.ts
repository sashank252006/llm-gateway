import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { logger as rootLogger } from '../../observability/logger.js';
import { overheadSeconds, requestDuration, requestsTotal } from '../../observability/metrics.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      log: ReturnType<typeof rootLogger.child>;
      startTime: number;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const id =
    typeof inbound === 'string' && /^(req_[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{16,64})$/.test(inbound)
      ? inbound
      : `req_${randomBytes(8).toString('hex')}`;

  req.requestId = id;
  req.startTime = Date.now();
  req.log = rootLogger.child({ requestId: id });
  res.setHeader('x-request-id', id);
  res.locals.upstreamLatencyMs = 0;
  res.on('finish', () => {
    if (req.path !== '/v1/chat/completions') return;
    const body = req.body as { model?: string; stream?: boolean } | undefined;
    const alias = body?.model ?? 'unknown';
    const cache = String(res.getHeader('x-gateway-cache') ?? 'skip').toLowerCase();
    const latencyMs = Date.now() - req.startTime;
    requestsTotal.inc({ alias, http_status: String(res.statusCode), cache });
    requestDuration.observe({ alias, stream: String(body?.stream === true) }, latencyMs / 1000);
    overheadSeconds.observe(Math.max(0, latencyMs - Number(res.locals.upstreamLatencyMs ?? 0)) / 1000);
    req.log.info({ msg: 'request completed', method: req.method, path: req.path, status: res.statusCode, latency_ms: latencyMs, alias, cache });
  });
  next();
}
