import { Router } from 'express';
import { currentUser, requireAuth, requireRole, SUPERVISOR_ROLES } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { dashExport } from './export.js';
import { exportQuery, monthQuery, periodQuery, unitParams, userParams } from './schemas.js';
import { childrenTable, overview, unitVillages, zimmedarDays, zimmedaranTable } from './service.js';

/** Supervisor dashboards. Zimmedaran get 403 on every /dash route. */
export function dashRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole(...SUPERVISOR_ROLES));

  router.get('/units/:code/overview', async (req, res) => {
    const { code } = parse(unitParams, req.params);
    const { period, date } = parse(periodQuery, req.query);
    res.json(await overview(currentUser(req), code, period, date));
  });

  router.get('/units/:code/zimmedaran', async (req, res) => {
    const { code } = parse(unitParams, req.params);
    const { period, date } = parse(periodQuery, req.query);
    res.json(await zimmedaranTable(currentUser(req), code, period, date));
  });

  router.get('/units/:code/children', async (req, res) => {
    const { code } = parse(unitParams, req.params);
    const { period, date } = parse(periodQuery, req.query);
    res.json(await childrenTable(currentUser(req), code, period, date));
  });

  router.get('/units/:code/villages', async (req, res) => {
    const { code } = parse(unitParams, req.params);
    const { month } = parse(monthQuery, req.query);
    res.json(await unitVillages(currentUser(req), code, month));
  });

  router.get('/zimmedaran/:userId/days', async (req, res) => {
    const { userId } = parse(userParams, req.params);
    const { month } = parse(monthQuery, req.query);
    res.json(await zimmedarDays(currentUser(req), userId, month));
  });

  router.get('/export.xlsx', async (req, res) => {
    const { file, name } = await dashExport(currentUser(req), parse(exportQuery, req.query));
    res
      .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', `attachment; filename="${name}"`)
      .set('Cache-Control', 'no-store')
      .send(file);
  });

  return router;
}
