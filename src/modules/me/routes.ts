import { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { buildMeWorkbook } from './export.js';
import { summaryQuery } from './schemas.js';
import { exportRows, reward, summary } from './service.js';

export function meRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole('zimmedar'));

  router.get('/summary', async (req, res) => {
    res.json(await summary(currentUser(req), parse(summaryQuery, req.query)));
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
    });
    const name = `ushr-${user.ajeerCode}-${query.period}-${data.date}.xlsx`;
    res
      .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', `attachment; filename="${name}"`)
      .set('Cache-Control', 'no-store')
      .send(file);
  });

  return router;
}
