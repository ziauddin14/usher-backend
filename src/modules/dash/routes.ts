import { Router } from 'express';
import { currentUser, DASHBOARD_ROLES, requireAuth, requireRole } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { dashExport } from './export.js';
import { exportQuery, monthQuery, periodQuery, unitParams, userParams } from './schemas.js';
import { unitErp } from '../erp/service.js';
import {
  childrenTable,
  overview,
  unitTasks,
  unitVillages,
  zimmedarDays,
  zimmedaranTable,
} from './service.js';

/**
 * Read-only dashboards for supervisors and Tehsil Zimmedaran (each in their own scope, by unit
 * path). Ushar Zimmedaran get 403 on every /dash route.
 */
export function dashRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole(...DASHBOARD_ROLES));

  router.get('/units/:code/overview', async (req, res) => {
    const { code } = parse(unitParams, req.params);
    const { period, date, from } = parse(periodQuery, req.query);
    res.json(await overview(currentUser(req), code, period, date, from));
  });

  router.get('/units/:code/zimmedaran', async (req, res) => {
    const { code } = parse(unitParams, req.params);
    const { period, date, from } = parse(periodQuery, req.query);
    res.json(await zimmedaranTable(currentUser(req), code, period, date, from));
  });

  router.get('/units/:code/children', async (req, res) => {
    const { code } = parse(unitParams, req.params);
    const { period, date, from } = parse(periodQuery, req.query);
    res.json(await childrenTable(currentUser(req), code, period, date, from));
  });

  /** ERP (E-Raseed) receipts of the unit in the period (CTO 11 Nov 2026). */
  router.get('/units/:code/erp', async (req, res) => {
    const { code } = parse(unitParams, req.params);
    res.json(await unitErp(currentUser(req), code, parse(periodQuery, req.query)));
  });

  /** Meeting-task and other-work counts of the unit in the period (CTO 13 Nov 2026). */
  router.get('/units/:code/tasks', async (req, res) => {
    const { code } = parse(unitParams, req.params);
    const { period, date, from } = parse(periodQuery, req.query);
    res.json(await unitTasks(currentUser(req), code, period, date, from));
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
