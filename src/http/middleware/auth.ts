import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { GatewayError } from '../../domain/errors.js';
import { lookupKey } from '../../keys/index.js';
import type { PrismaClient } from '@prisma/client';
import type { ApiKeyContext } from '../../domain/types.js';

declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKeyContext;
    }
  }
}

export function authMiddleware(prisma: PrismaClient) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new GatewayError('invalid_api_key', 'Invalid or revoked API key'));
    }

    const key = authHeader.slice(7);
    if (!key || !key.startsWith('lgw_')) {
      return next(new GatewayError('invalid_api_key', 'Invalid or revoked API key'));
    }

    const hash = createHash('sha256').update(key).digest('hex');

    try {
      const keyCtx = await lookupKey(hash, prisma);
      req.apiKey = keyCtx;
      next();
    } catch (err) {
      next(err);
    }
  };
}

