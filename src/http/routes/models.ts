import { Router } from 'express';
import { getAliases } from '../../routing/router.js';

export function modelsRouter(): Router {
  const router = Router();

  router.get('/v1/models', (_req, res) => {
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

