import { Router } from 'express';
import { pingDb } from '../../lib/db.js';

export function healthRouter(): Router {
  const router = Router();

  /** Public. 200 when the database answers, 503 (same body) when it does not. */
  router.get('/', async (_req, res) => {
    const up = await pingDb();
    res
      .status(up ? 200 : 503)
      .json({ ok: up, db: up ? 'up' : 'down', time: new Date().toISOString() });
  });

  return router;
}
