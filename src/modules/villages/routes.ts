import { Router } from 'express';
import { currentUser, requireAuth, requireRole, SUPERVISOR_ROLES } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { approveVillage, assignVillage, listPending, mergeVillage } from './manage.js';
import {
  addVillageSchema,
  approveSchema,
  assignSchema,
  listVillagesQuery,
  mergeSchema,
  villageIdParams,
} from './schemas.js';
import { addVillage, listVillages } from './service.js';

// Zimmedar: list + add. District and above (Step 4): pending list, approve, merge, assign.
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

  const supervisor = requireRole(...SUPERVISOR_ROLES);

  router.get('/pending', supervisor, async (req, res) => {
    res.json({ villages: await listPending(currentUser(req)) });
  });

  router.post('/:id/approve', supervisor, async (req, res) => {
    const { id } = parse(villageIdParams, req.params);
    const { name } = parse(approveSchema, req.body ?? {});
    res.json({ village: await approveVillage(currentUser(req), id, name) });
  });

  router.post('/:id/merge', supervisor, async (req, res) => {
    const { id } = parse(villageIdParams, req.params);
    const { intoId } = parse(mergeSchema, req.body);
    res.json(await mergeVillage(currentUser(req), id, intoId));
  });

  router.post('/:id/assign', supervisor, async (req, res) => {
    const { id } = parse(villageIdParams, req.params);
    const { userId } = parse(assignSchema, req.body);
    res.json({ village: await assignVillage(currentUser(req), id, userId) });
  });

  return router;
}
