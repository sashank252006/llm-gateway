import { Router } from 'express';
import { registry } from '../../observability/metrics.js';

export function metricsRouter(): Router {
  const router = Router();

  router.get('/metrics', async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });

  return router;
}

