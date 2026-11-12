import { Request, Response, NextFunction } from 'express';
import { ChatRequestSchema } from '../../domain/schemas.js';
import { GatewayError } from '../../domain/errors.js';

export function validateChatRequest(req: Request, _res: Response, next: NextFunction): void {
  const result = ChatRequestSchema.safeParse(req.body);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue?.code === 'unrecognized_keys') {
      const keys = (issue as unknown as { keys: string[] }).keys;
      return next(
        new GatewayError('unsupported_parameter', `Unsupported parameter: ${keys?.join(', ')}`, {
          param: keys?.[0],
        })
      );
    }
    return next(new GatewayError('invalid_request', issue?.message ?? 'Invalid request'));
  }

  const apiKey = req.apiKey;
  if (apiKey && result.data.max_tokens && result.data.max_tokens > apiKey.maxOutputTokensCap) {
    return next(
      new GatewayError(
        'invalid_request',
        `max_tokens ${result.data.max_tokens} exceeds key limit of ${apiKey.maxOutputTokensCap}`
      )
    );
  }

  req.body = result.data;
  next();
}

