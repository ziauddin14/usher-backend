import { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { addVillageSchema, listVillagesQuery } from './schemas.js';
import { addVillage, listVillages } from './service.js';

// Approve / merge / pending list are dashboard features (Step 4).
export function villagesRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const { q } = parse(listVillagesQuery, req.query);
    res.json({ villages: await listVillages(currentUser(req), q) });
  });

  router.post('/', requireRole('zimmedar'), async (req, res) => {
    const { name } = parse(addVillageSchema, req.body);
    res.status(201).json({ village: await addVillage(currentUser(req), name) });
  });

  return router;
}
