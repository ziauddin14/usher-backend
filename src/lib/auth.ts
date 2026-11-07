import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { type Department, type Role, ROLE_RANK, User, type Zimmedari } from '../models/user.js';
import { connectDb } from './db.js';
import { env } from './env.js';
import { AppError } from './errors.js';

export const SESSION_COOKIE = 'ushr_session';
const SESSION_HOURS = 12;

/** The caller, loaded fresh from the database on every request (role / active status can change). */
export interface AuthUser {
  id: string;
  ajeerCode: string;
  name: string;
  nameUr?: string;
  role: Role;
  zimmedari?: Zimmedari;
  unitCode: string;
  unitPath: string;
  mustChangePassword: boolean;
  /** users.sessionVersion when the session was checked (see signSession). */
  sessionVersion?: number;
  /** Department of a centrally provisioned account (e.g. CENTRAL_IT), re-read on every request. */
  department?: Department;
}

interface TokenPayload {
  sub: string;
  role: Role;
  /** users.sessionVersion at login; a reset bumps it and so ends every older session. */
  sv?: number;
}

export function signSession(user: { id: string; role: Role; sessionVersion?: number }): string {
  const payload: TokenPayload = { sub: user.id, role: user.role, sv: user.sessionVersion ?? 0 };
  return jwt.sign(payload, env().JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${SESSION_HOURS}h`,
  });
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().NODE_ENV === 'production',
    path: '/',
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_HOURS * 3600 * 1000 });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

function readToken(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const fromCookie = cookies?.[SESSION_COOKIE];
  if (fromCookie) return fromCookie;
  const header = req.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

function verify(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, env().JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'object' && typeof decoded.sub === 'string') {
      return decoded as unknown as TokenPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 401 unless a valid session belongs to an active user; sets `req.user`.
 * While a password change is pending (first login / after a reset) every other endpoint
 * answers 403 PASSWORD_CHANGE_REQUIRED — only `requireSession` routes stay open.
 * A session from before a password reset or a deactivation (older sessionVersion) answers 401.
 * A mobile number is never needed (CTO 7 Nov 2026).
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  await loadSessionUser(req);
  if (req.user?.mustChangePassword) {
    throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password first');
  }
  next();
};

/** Like requireAuth but also allowed while a password change is pending (me, change-password). */
export const requireSession: RequestHandler = async (req, _res, next) => {
  await loadSessionUser(req);
  next();
};

async function loadSessionUser(req: Request): Promise<void> {
  const token = readToken(req);
  const payload = token ? verify(token) : null;
  if (!payload || !Types.ObjectId.isValid(payload.sub)) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Login required');
  }
  await connectDb();
  const user = await User.findById(payload.sub)
    .select(
      'ajeerCode name nameUr role zimmedari unitCode unitPath isActive mustChangePassword sessionVersion department',
    )
    .lean();
  if (!user?.isActive || (payload.sv ?? 0) !== (user.sessionVersion ?? 0)) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Login required');
  }
  req.user = {
    id: String(user._id),
    ajeerCode: user.ajeerCode,
    name: user.name,
    ...(user.nameUr ? { nameUr: user.nameUr } : {}),
    role: user.role,
    ...(user.zimmedari ? { zimmedari: user.zimmedari } : {}),
    unitCode: user.unitCode,
    unitPath: user.unitPath,
    mustChangePassword: user.mustChangePassword,
    sessionVersion: user.sessionVersion ?? 0,
    ...(user.department ? { department: user.department } : {}),
  };
}

/** 403 unless the caller has one of the roles. Use after `requireAuth`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Not allowed for this role');
    }
    next();
  };
}

/** Supervisors: district and above. */
export const SUPERVISOR_ROLES: Role[] = ['district', 'division', 'suba', 'pakistan'];

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Login required');
  return req.user;
}

export function isLowerRole(target: Role, than: Role): boolean {
  return ROLE_RANK[target] < ROLE_RANK[than];
}
