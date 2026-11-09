import { Router } from 'express';
import {
  currentUser,
  DASHBOARD_ROLES,
  requireAuth,
  requireRole,
  SUPERVISOR_ROLES,
} from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { listUsersQuery, statusSchema, userIdParams } from './schemas.js';
import { listResetRequests, listUsers, resetPassword, setUserStatus } from './service.js';

// Supervisors: users below them, forgot-password requests, password reset, activate / deactivate.
// A Tehsil Zimmedar only lists the Ushar Zimmedaran of their own Tehsil (CTO 9 Nov 2026): no
// reset requests, no password reset, no activate / deactivate.
export function usersRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole(...DASHBOARD_ROLES));
  const supervisor = requireRole(...SUPERVISOR_ROLES);

  router.get('/', async (req, res) => {
    const query = parse(listUsersQuery, req.query);
    res.json({ users: await listUsers(currentUser(req), query) });
  });

  router.get('/reset-requests', supervisor, async (req, res) => {
    res.json({ requests: await listResetRequests(currentUser(req)) });
  });

  router.post('/:id/reset-password', supervisor, async (req, res) => {
    const { id } = parse(userIdParams, req.params);
    await resetPassword(currentUser(req), id);
    res.json({ ok: true });
  });

  router.post('/:id/status', supervisor, async (req, res) => {
    const { id } = parse(userIdParams, req.params);
    const { isActive } = parse(statusSchema, req.body);
    await setUserStatus(currentUser(req), id, isActive);
    res.json({ ok: true });
  });

  return router;
}
