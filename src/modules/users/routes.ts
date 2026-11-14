import { Router } from 'express';
import {
  currentUser,
  DASHBOARD_ROLES,
  requireAuth,
  requireRole,
  EDITOR_ROLES,
} from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { createUserSchema, listUsersQuery, statusSchema, userIdParams } from './schemas.js';
import { createZimmedar, listDistricts } from './create.js';
import { listResetRequests, listUsers, resetPassword, setUserStatus } from './service.js';

// Users. Every dashboard role lists the users below it in its scope (view); only the Admin creates
// a zimmedar, sees forgot-password requests, resets and activates / deactivates (CTO 14 Nov 2026).
export function usersRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole(...DASHBOARD_ROLES));
  const admin = requireRole(...EDITOR_ROLES);

  router.get('/', async (req, res) => {
    const query = parse(listUsersQuery, req.query);
    res.json({ users: await listUsers(currentUser(req), query) });
  });

  router.post('/', admin, async (req, res) => {
    const body = parse(createUserSchema, req.body);
    res.status(201).json({ user: await createZimmedar(currentUser(req), body) });
  });

  router.get('/districts', admin, async (req, res) => {
    res.json({ districts: await listDistricts(currentUser(req)) });
  });

  router.get('/reset-requests', admin, async (req, res) => {
    res.json({ requests: await listResetRequests(currentUser(req)) });
  });

  router.post('/:id/reset-password', admin, async (req, res) => {
    const { id } = parse(userIdParams, req.params);
    await resetPassword(currentUser(req), id);
    res.json({ ok: true });
  });

  router.post('/:id/status', admin, async (req, res) => {
    const { id } = parse(userIdParams, req.params);
    const { isActive } = parse(statusSchema, req.body);
    await setUserStatus(currentUser(req), id, isActive);
    res.json({ ok: true });
  });

  return router;
}
