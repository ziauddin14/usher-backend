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
  mobileChangeSchema,
} from './schemas.js';
import {
  cancelMobileChange,
  changePassword,
  login,
  ownMobile,
  publicUser,
  requestMobileChange,
  requestPasswordReset,
} from './service.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * 5 failed logins per Ajeer code + IP in 15 minutes → 429. Successful logins, the
 * "now enter your mobile" step of a first login and "mobile waits for the District"
 * (MOBILE_PENDING — the password was right) do not count.
 * In-memory store: per serverless instance (enough for the demo).
 */
function loginLimiter() {
  return rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit: 5,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) =>
      res.statusCode < 400 || (res.locals as { mobileStep?: boolean }).mobileStep === true,
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
    const { ajeerCode, password, mobile } = parse(loginSchema, req.body);
    try {
      const user = await login(ajeerCode, password, mobile, req.ip);
      setSessionCookie(res, signSession(user));
      res.json({ user: await publicUser(user) });
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'MOBILE_REQUIRED' || error.code === 'MOBILE_PENDING')
      ) {
        (res.locals as { mobileStep?: boolean }).mobileStep = true;
      }
      throw error;
    }
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

  // Own mobile and a later change of it (confirmed by the user's verifier, CTO 7 Nov 2026).
  // requireAuth: not while a password change is pending.
  router.get('/mobile', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await ownMobile(currentUser(req)));
  });

  router.post('/mobile-change', requireAuth, async (req, res) => {
    const { mobile } = parse(mobileChangeSchema, req.body);
    await requestMobileChange(currentUser(req), mobile);
    res.json({ ok: true });
  });

  router.delete('/mobile-change', requireAuth, async (req, res) => {
    await cancelMobileChange(currentUser(req));
    res.json({ ok: true });
  });

  return router;
}
