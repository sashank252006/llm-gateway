import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { getAliases } from '../../routing/router.js';
import { authMiddleware } from '../middleware/auth.js';

export function modelsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/v1/models', authMiddleware(prisma), (_req, res) => {
    const aliases = getAliases();
    res.json({
      object: 'list',
      data: aliases.map((id) => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'llm-gateway',
      })),
    });
  });

  return router;
}
