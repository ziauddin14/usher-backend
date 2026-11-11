import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { MAX_ERP_FILE_BYTES, uploadQuery } from './schemas.js';
import { ERP_TEMPLATE_CSV, erpUpload, recentUploads } from './service.js';

/**
 * The daily E-Raseed (ERP) file (CTO 11 Nov 2026): only the Pakistan level uploads it. Reports
 * are under /dash/units/:code/erp (every dashboard, own scope) and /me/erp (the zimmedar).
 */
export function erpRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole('pakistan'));

  router.post(
    '/uploads',
    express.raw({ type: () => true, limit: MAX_ERP_FILE_BYTES }),
    async (req, res) => {
      const { name, commit } = parse(uploadQuery, req.query);
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await erpUpload(currentUser(req), bytes, name, commit === 'true');
      res.status(result.committed ? 201 : 200).json(result);
    },
  );

  router.get('/uploads', async (_req, res) => {
    res.json(await recentUploads());
  });

  router.get('/template.csv', (_req, res) => {
    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="UsherDesk-ERP-format.csv"')
      // A byte-order mark first, so Excel opens the UTF-8 file with Urdu text intact.
      .send(`${String.fromCharCode(0xfeff)}${ERP_TEMPLATE_CSV}\r\n`);
  });

  return router;
}
