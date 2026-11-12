import { Request, Response, NextFunction } from 'express';
import { GatewayError } from '../../domain/errors.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof GatewayError) {
    if (err.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }
    res.status(err.httpStatus).json({
      error: {
        message: err.message,
        type: err.errorType,
        code: err.code,
        param: err.param ?? null,
        request_id: req.requestId,
      },
    });
    return;
  }

  req.log?.error({ msg: 'Unhandled error', error: err.message, stack: err.stack });
  res.status(500).json({
    error: {
      message: 'An internal error occurred',
      type: 'api_error',
      code: 'internal_error',
      param: null,
      request_id: req.requestId,
    },
  });
}

