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

  // Prisma's record-not-found error belongs to the API surface, not a 500.
  if ((err as { code?: string }).code === 'P2025') {
    res.status(404).json({
      error: { message: 'Resource not found', type: 'invalid_request_error', code: 'model_not_found', param: null, request_id: req.requestId },
    });
    return;
  }

  // express.json exposes well-defined client errors. They must never be
  // presented as a gateway outage or pollute the 500 metric.
  const bodyError = err as Error & { type?: string; status?: number; limit?: number };
  if (bodyError.type === 'entity.parse.failed') {
    res.status(400).json({
      error: { message: 'Invalid JSON request body', type: 'invalid_request_error', code: 'invalid_request', param: null, request_id: req.requestId },
    });
    return;
  }
  if (bodyError.type === 'entity.too.large' || bodyError.status === 413) {
    res.status(413).json({
      error: { message: 'Request body is too large', type: 'invalid_request_error', code: 'request_too_large', param: null, request_id: req.requestId },
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
