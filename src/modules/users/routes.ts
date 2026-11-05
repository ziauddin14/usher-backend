import { Router } from 'express';
import { currentUser, requireAuth, requireRole, SUPERVISOR_ROLES } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { listUsersQuery, statusSchema, userIdParams } from './schemas.js';
import {
  confirmMobile,
  listResetRequests,
  listUsers,
  rejectMobile,
  viewPendingMobile,
  resetPassword,
  setUserStatus,
} from './service.js';

export function usersRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole(...SUPERVISOR_ROLES));

  router.get('/', async (req, res) => {
    const query = parse(listUsersQuery, req.query);
    res.json({ users: await listUsers(currentUser(req), query) });
  });

  router.get('/reset-requests', async (req, res) => {
    res.json({ requests: await listResetRequests(currentUser(req)) });
  });

  router.post('/:id/reset-password', async (req, res) => {
    const { id } = parse(userIdParams, req.params);
    await resetPassword(currentUser(req), id);
    res.json({ ok: true });
  });

  router.post('/:id/confirm-mobile', async (req, res) => {
    const { id } = parse(userIdParams, req.params);
    await confirmMobile(currentUser(req), id);
    res.json({ ok: true });
  });

  // Full pending number for the District (audited); never cached by the browser.
  router.get('/:id/pending-mobile', async (req, res) => {
    const { id } = parse(userIdParams, req.params);
    const mobile = await viewPendingMobile(currentUser(req), id);
    res.set('Cache-Control', 'no-store').json({ mobile });
  });

  router.post('/:id/reject-mobile', async (req, res) => {
    const { id } = parse(userIdParams, req.params);
    await rejectMobile(currentUser(req), id);
    res.json({ ok: true });
  });

  router.post('/:id/status', async (req, res) => {
    const { id } = parse(userIdParams, req.params);
    const { isActive } = parse(statusSchema, req.body);
    await setUserStatus(currentUser(req), id, isActive);
    res.json({ ok: true });
  });

  return router;
}
