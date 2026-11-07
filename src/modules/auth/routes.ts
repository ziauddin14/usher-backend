import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import {
  clearSessionCookie,
  currentUser,
  requireAuth,
  requireSession,
  setSessionCookie,
  signSession,
} from '../../lib/auth.js';
import { AppError, parse } from '../../lib/errors.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  updateMobileSchema,
} from './schemas.js';
import {
  changePassword,
  login,
  ownMobile,
  publicUser,
  requestPasswordReset,
  updateOwnMobile,
} from './service.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * 5 failed logins per Ajeer code + IP in 15 minutes → 429. Successful logins do not count.
 * In-memory store: per instance (enough for the demo).
 */
function loginLimiter() {
  return rateLimit({
    windowMs: FIFTEEN_MINUTES,
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

/** Forgot-password requests: 5 per IP in 15 minutes. */
function forgotLimiter() {
  return rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests, try again in 15 minutes'));
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

  router.post('/forgot-password', forgotLimiter(), async (req, res) => {
    const { ajeerCode, mobile } = parse(forgotPasswordSchema, req.body);
    await requestPasswordReset(ajeerCode, mobile);
    res.json({ ok: true });
  });

  router.get('/me', requireSession, async (req, res) => {
    res.json({ user: await publicUser(currentUser(req)) });
  });

  router.post('/change-password', requireSession, async (req, res) => {
    const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
    await changePassword(currentUser(req), currentPassword, newPassword);
    res.json({ ok: true });
  });

  // Own optional mobile (CTO 7 Nov 2026): the user sets / changes / removes it directly — no
  // approval. requireAuth: not while a password change is pending.
  router.get('/mobile', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await ownMobile(currentUser(req)));
  });

  router.put('/mobile', requireAuth, async (req, res) => {
    const { mobile } = parse(updateMobileSchema, req.body);
    res.json({ mobile: await updateOwnMobile(currentUser(req), mobile) });
  });

  return router;
}
