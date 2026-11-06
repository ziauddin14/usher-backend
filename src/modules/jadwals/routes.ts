import { Router } from 'express';
import { currentUser, requireAuth, requireRole, SUPERVISOR_ROLES } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import {
  addVisitSchema,
  atiyatSchema,
  createJadwalSchema,
  donorsSchema,
  ijtimaSchema,
  jadwalIdParams,
  listJadwalsQuery,
  mashwaraSchema,
  patchJadwalSchema,
  dutyApprovalSchema,
  reopenSchema,
  submitSchema,
  visitParams,
} from './schemas.js';
import {
  addVisit,
  createJadwal,
  deleteVisit,
  getJadwal,
  listOwnJadwals,
  patchJadwal,
  reopenJadwal,
  saveStep,
  submitJadwal,
  todayJadwal,
} from './service.js';
import { decideDuty } from './duty.js';

export function jadwalsRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  const zimmedar = requireRole('zimmedar');

  router.get('/today', zimmedar, async (req, res) => {
    res.json(await todayJadwal(currentUser(req)));
  });

  router.get('/', zimmedar, async (req, res) => {
    const { from, to } = parse(listJadwalsQuery, req.query);
    res.json({ jadwals: await listOwnJadwals(currentUser(req), from, to) });
  });

  router.post('/', zimmedar, async (req, res) => {
    const body = parse(createJadwalSchema, req.body);
    res.status(201).json({ jadwal: await createJadwal(currentUser(req), body) });
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(jadwalIdParams, req.params);
    res.json({ jadwal: await getJadwal(currentUser(req), id) });
  });

  router.patch('/:id', zimmedar, async (req, res) => {
    const { id } = parse(jadwalIdParams, req.params);
    const body = parse(patchJadwalSchema, req.body);
    res.json({ jadwal: await patchJadwal(currentUser(req), id, body) });
  });

  router.post('/:id/visits', zimmedar, async (req, res) => {
    const { id } = parse(jadwalIdParams, req.params);
    const { villageId } = parse(addVisitSchema, req.body);
    res.status(201).json({ jadwal: await addVisit(currentUser(req), id, villageId) });
  });

  router.delete('/:id/visits/:visitId', zimmedar, async (req, res) => {
    const { id, visitId } = parse(visitParams, req.params);
    res.json({ jadwal: await deleteVisit(currentUser(req), id, visitId) });
  });

  router.put('/:id/visits/:visitId/donors', zimmedar, async (req, res) => {
    const { id, visitId } = parse(visitParams, req.params);
    res.json(
      await saveStep(currentUser(req), id, visitId, 'donors', parse(donorsSchema, req.body)),
    );
  });

  router.put('/:id/visits/:visitId/atiyat', zimmedar, async (req, res) => {
    const { id, visitId } = parse(visitParams, req.params);
    res.json(
      await saveStep(currentUser(req), id, visitId, 'atiyat', parse(atiyatSchema, req.body)),
    );
  });

  router.put('/:id/visits/:visitId/ijtima', zimmedar, async (req, res) => {
    const { id, visitId } = parse(visitParams, req.params);
    res.json(
      await saveStep(currentUser(req), id, visitId, 'ijtima', parse(ijtimaSchema, req.body)),
    );
  });

  router.put('/:id/visits/:visitId/mashwara', zimmedar, async (req, res) => {
    const { id, visitId } = parse(visitParams, req.params);
    res.json(
      await saveStep(currentUser(req), id, visitId, 'mashwara', parse(mashwaraSchema, req.body)),
    );
  });

  router.post('/:id/submit', zimmedar, async (req, res) => {
    const { id } = parse(jadwalIdParams, req.params);
    const body = parse(submitSchema, req.body);
    res.json({ jadwal: await submitJadwal(currentUser(req), id, body) });
  });

  router.post('/:id/reopen', requireRole(...SUPERVISOR_ROLES), async (req, res) => {
    const { id } = parse(jadwalIdParams, req.params);
    const { reason } = parse(reopenSchema, req.body);
    res.json({ jadwal: await reopenJadwal(currentUser(req), id, reason) });
  });

  // Official duty of a full-day mashwara: the owner's level directly above only (duty.ts).
  router.post('/:id/duty-approval', requireRole(...SUPERVISOR_ROLES), async (req, res) => {
    const { id } = parse(jadwalIdParams, req.params);
    const body = parse(dutyApprovalSchema, req.body);
    res.json({ dutyApproval: await decideDuty(currentUser(req), id, body) });
  });

  return router;
}
