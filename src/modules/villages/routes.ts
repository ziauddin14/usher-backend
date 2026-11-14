import { Router } from 'express';
import { currentUser, requireAuth, requireRole, EDITOR_ROLES } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import {
  approveVillage,
  assignVillage,
  createVillage,
  listDuplicates,
  listPending,
  mergeVillage,
  resolveIssue,
  updateVillage,
} from './manage.js';
import {
  addVillageSchema,
  approveSchema,
  assignSchema,
  createVillageSchema,
  duplicatesQuery,
  updateVillageSchema,
  listVillagesQuery,
  mergeSchema,
  resolveIssueSchema,
  villageIdParams,
} from './schemas.js';
import { addVillage, listVillages } from './service.js';
import { villageDonors } from '../donors/service.js';
import { donorsQuery } from './schemas.js';

// Zimmedar: list + add. District and above: pending list, approve, merge, assign, add, correct,
// duplicates — always inside the caller's own units (scope enforced in manage.ts).
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

  const admin = requireRole(...EDITOR_ROLES);

  /** The Gaon's old donors and local zimmedar, for the zimmedar it is assigned to (CTO 12 Nov 2026). */
  router.get('/:id/donors', requireRole('zimmedar'), async (req, res) => {
    const { id } = parse(villageIdParams, req.params);
    const { date } = parse(donorsQuery, req.query);
    res.json(await villageDonors(currentUser(req), id, date));
  });

  router.get('/pending', admin, async (req, res) => {
    res.json({ villages: await listPending(currentUser(req)) });
  });

  // District village management (CTO 7 Nov 2026): add, correct, find duplicates.
  router.post('/manage', admin, async (req, res) => {
    const input = parse(createVillageSchema, req.body);
    res.status(201).json({ village: await createVillage(currentUser(req), input) });
  });

  router.get('/duplicates', admin, async (req, res) => {
    const { unit } = parse(duplicatesQuery, req.query);
    res.json({ groups: await listDuplicates(currentUser(req), unit) });
  });

  router.patch('/:id', admin, async (req, res) => {
    const { id } = parse(villageIdParams, req.params);
    const input = parse(updateVillageSchema, req.body);
    res.json({ village: await updateVillage(currentUser(req), id, input) });
  });

  router.post('/:id/approve', admin, async (req, res) => {
    const { id } = parse(villageIdParams, req.params);
    const { name } = parse(approveSchema, req.body ?? {});
    res.json({ village: await approveVillage(currentUser(req), id, name) });
  });

  router.post('/:id/merge', admin, async (req, res) => {
    const { id } = parse(villageIdParams, req.params);
    const { intoId } = parse(mergeSchema, req.body);
    res.json(await mergeVillage(currentUser(req), id, intoId));
  });

  router.post('/:id/assign', admin, async (req, res) => {
    const { id } = parse(villageIdParams, req.params);
    const { userId } = parse(assignSchema, req.body);
    res.json({ village: await assignVillage(currentUser(req), id, userId) });
  });

  /** A pool Gaon's problem handled by the District (CTO 13 Nov 2026). */
  router.post('/:id/resolve-issue', admin, async (req, res) => {
    const { id } = parse(villageIdParams, req.params);
    const { kind } = parse(resolveIssueSchema, req.body);
    res.json({ village: await resolveIssue(currentUser(req), id, kind) });
  });

  return router;
}
