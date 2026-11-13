import { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { buildMeWorkbook } from './export.js';
import { summaryQuery } from './schemas.js';
import { myErp } from '../erp/service.js';
import { exportRows, myPledges, myTasks, reward, summary } from './service.js';
import { taskCounts } from '../reports/tasks.js';
import { Types } from 'mongoose';

export function meRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole('zimmedar'));

  router.get('/summary', async (req, res) => {
    res.json(await summary(currentUser(req), parse(summaryQuery, req.query)));
  });

  /** Own ERP (E-Raseed) receipts in the period (CTO 11 Nov 2026). */
  router.get('/erp', async (req, res) => {
    res.json(await myErp(currentUser(req), parse(summaryQuery, req.query)));
  });

  /** Own task counts in the period (CTO 13 Nov 2026). */
  router.get('/tasks', async (req, res) => {
    res.json(await myTasks(currentUser(req), parse(summaryQuery, req.query)));
  });

  /** Own niyyat: open now (by type, by month), written and received in the period. */
  router.get('/pledges', async (req, res) => {
    res.json(await myPledges(currentUser(req), parse(summaryQuery, req.query)));
  });

  router.get('/reward', async (req, res) => {
    res.json(await reward(currentUser(req)));
  });

  router.get('/export.xlsx', async (req, res) => {
    const user = currentUser(req);
    const query = parse(summaryQuery, req.query);
    const data = await exportRows(user, query);
    const file = await buildMeWorkbook({
      title: `${user.nameUr ?? user.name} · اجیر کوڈ ${user.ajeerCode} · ${data.from} تا ${data.to}`,
      rows: data.rows,
      totals: data.totals,
      tasks: await taskCounts({
        userId: new Types.ObjectId(user.id),
        from: data.from,
        to: data.to,
      }),
    });
    const span = query.period === 'range' ? `${data.from}_${data.to}` : data.date;
    const name = `UsherDesk-${user.ajeerCode}-${query.period}-${span}.xlsx`;
    res
      .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', `attachment; filename="${name}"`)
      .set('Cache-Control', 'no-store')
      .send(file);
  });

  return router;
}
