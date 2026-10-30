import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import {
  clearSessionCookie,
  currentUser,
  requireAuth,
  setSessionCookie,
  signSession,
} from '../../lib/auth.js';
import { AppError, parse } from '../../lib/errors.js';
import { changePasswordSchema, loginSchema } from './schemas.js';
import { changePassword, login, publicUser } from './service.js';

/**
 * 5 failed logins per Ajeer code + IP in 15 minutes → 429. Successful logins do not count.
 * In-memory store: per serverless instance (enough for the demo).
 */
function loginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const body = req.body as { ajeerCode?: unknown } | undefined;
      const code = typeof body?.ajeerCode === 'string' ? body.ajeerCode.trim() : '';
      return `${ipKeyGenerator(req.ip ?? '')}|${code}`;
    },
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Too many failed logins, try again in 15 minutes'));
    },
  });
}

export function authRouter(): Router {
  const router = Router();

  router.post('/login', loginLimiter(), async (req, res) => {
    const { ajeerCode, password } = parse(loginSchema, req.body);
    const user = await login(ajeerCode, password, req.ip);
    setSessionCookie(res, signSession(user));
    res.json({ user: await publicUser(user) });
  });

  router.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, async (req, res) => {
    res.json({ user: await publicUser(currentUser(req)) });
  });

  router.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
    await changePassword(currentUser(req), currentPassword, newPassword);
    res.json({ ok: true });
  });

  return router;
}
