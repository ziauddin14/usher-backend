import { Router } from 'express';
import { currentUser, requireAuth, requireRole, SUPERVISOR_ROLES } from '../../lib/auth.js';
import { parse } from '../../lib/errors.js';
import { listUsersQuery } from './schemas.js';
import { listUsers } from './service.js';

export function usersRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole(...SUPERVISOR_ROLES));

  router.get('/', async (req, res) => {
    const query = parse(listUsersQuery, req.query);
    res.json({ users: await listUsers(currentUser(req), query) });
  });

  return router;
}
