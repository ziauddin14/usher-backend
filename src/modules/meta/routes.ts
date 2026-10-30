import { Router } from 'express';
import { requireAuth } from '../../lib/auth.js';
import { getSettings } from '../../lib/settings.js';
import { karachiDate } from '../../lib/time.js';

export function metaRouter(): Router {
  const router = Router();

  /** Settings the UI needs (atiyat categories, reward rules, back-date window) + today in Karachi. */
  router.get('/', requireAuth, async (_req, res) => {
    const s = await getSettings();
    res.json({
      today: karachiDate(),
      backdateDays: s.backdateDays,
      maxKmPerDay: s.maxKmPerDay,
      weekStartsOn: s.weekStartsOn,
      atiyatCategories: [...s.atiyatCategories].sort((a, b) => a.order - b.order),
      reward: s.reward,
      targets: s.targets,
    });
  });

  return router;
}
