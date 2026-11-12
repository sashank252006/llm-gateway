import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { logger as rootLogger } from '../../observability/logger.js';

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
    typeof inbound === 'string' && /^req_[A-Za-z0-9]{8,}$/.test(inbound)
      ? inbound
      : `req_${randomBytes(8).toString('hex')}`;

  req.requestId = id;
  req.startTime = Date.now();
  req.log = rootLogger.child({ requestId: id });
  res.setHeader('x-request-id', id);
  next();
}
