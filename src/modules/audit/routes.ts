import { Router } from 'express';
import { currentUser, EDITOR_ROLES, requireAuth, requireRole } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { auditQuery } from './schemas.js';
import { listAdmins, listAudit } from './service.js';

// The audit log: the Admin only (CTO 14 Nov 2026).
export function auditRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole(...EDITOR_ROLES));

  router.get('/', async (req, res) => {
    const q = parse(auditQuery, req.query);
    res.json(await listAudit(currentUser(req), q));
  });

  router.get('/admins', async (_req, res) => {
    res.json({ admins: await listAdmins() });
  });

  return router;
}
