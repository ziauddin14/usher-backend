import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { maskMobile, normalizeMobile } from '../../lib/mobile.js';
import { PasswordResetRequest } from '../../models/password-reset-request.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { INITIAL_PASSWORD } from './schemas.js';

export const BCRYPT_COST = 10;

export interface PublicUser {
  /** Designated permissions (e.g. VERIFY_SUBA_MOBILE) — the UI shows the matching actions. */
  permissions: string[];
  /** Department of a centrally provisioned account (CENTRAL_IT), else absent. */
  department?: string;
  id: string;
  ajeerCode: string;
  name: string;
  nameUr?: string;
  role: AuthUser['role'];
  zimmedari?: AuthUser['zimmedari'];
  unit: { code: string; name: string; nameUr?: string; path: string; level: string };
  mustChangePassword: boolean;
}

/** `/auth/me` shape. Never includes the password hash. */
export async function publicUser(user: AuthUser): Promise<PublicUser> {
  const unit = await Unit.findOne({ code: user.unitCode })
    .select('code name nameUr path level')
    .lean();
  // A user whose unit is missing is a data error (seed / import). Fail loudly and never guess a
  // level: guessing "district" would show a Division or Suba user the wrong screens (CTO, 6 Nov).
  // Logged: ids and codes only — no names, mobiles or tokens.
  if (!unit) {
    console.error(
      `[auth] unit missing for user ${user.id} (role ${user.role}, unitCode ${user.unitCode}, unitPath ${user.unitPath})`,
    );
    throw new AppError(500, 'INTERNAL', 'User unit missing');
  }
  return {
    id: user.id,
    ajeerCode: user.ajeerCode,
    name: user.name,
    ...(user.nameUr ? { nameUr: user.nameUr } : {}),
    role: user.role,
    ...(user.zimmedari ? { zimmedari: user.zimmedari } : {}),
    unit: {
      code: unit.code,
      name: unit.name,
      ...(unit.nameUr ? { nameUr: unit.nameUr } : {}),
      path: unit.path,
      level: unit.level,
    },
    mustChangePassword: user.mustChangePassword,
    permissions: user.permissions ?? [],
    ...(user.department ? { department: user.department } : {}),
  };
}

/**
 * Check Ajeer Code + password. While the user still has the initial password
 * (mustChangePassword) the registered mobile must match too.
 * A self-entered mobile (no number on record) is saved as "tasdeeq baqi" and the login stops with
 * 403 MOBILE_PENDING until the District confirms it (CTO 5 Nov 2026) — no session before that.
 * Every attempt is audit-logged (never the password, never the full mobile).
 */
export async function login(
  ajeerCode: string,
  password: string,
  mobile: string | undefined,
  ip: string | undefined,
) {
  await connectDb();
  const user = await User.findOne({ ajeerCode }).select('+passwordHash').lean();
  // Compare against a dummy hash for unknown codes too, so the answer time does not tell
  // which ajeer codes exist.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? (await dummyHash()));

  const failed = async (reason: string) =>
    audit({
      action: 'LOGIN_FAILED',
      ...(user ? { actorId: String(user._id), unitPath: user.unitPath } : {}),
      actorAjeerCode: ajeerCode,
      details: { reason, ip },
    });

  if (!user || !ok) {
    await failed(user ? 'wrong_password' : 'unknown_code');
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Ajeer code or password is incorrect');
  }
  if (!user.isActive) {
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is not active');
  }
  if (user.mustChangePassword) {
    if (!mobile) {
      throw new AppError(401, 'MOBILE_REQUIRED', 'Enter your registered mobile number');
    }
    const typed = normalizeMobile(mobile);
    if (!typed) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Mobile is not a valid Pakistani mobile number',
        {
          field: 'mobile',
        },
      );
    }
    if (!user.mobile) {
      // No number on record: keep the one the user typed, "tasdeeq baqi" until the District
      // confirms. Only into an empty slot — a number saved meanwhile is never replaced.
      const saved = await User.updateOne(
        { _id: user._id, mobile: { $exists: false } },
        { $set: { mobile: typed, mobileVerified: false } },
      );
      if (saved.modifiedCount === 0) {
        await failed('mobile_mismatch');
        throw new AppError(401, 'MOBILE_MISMATCH', 'Mobile number does not match');
      }
      await audit({
        action: 'MOBILE_SELF_REGISTER',
        actorId: String(user._id),
        actorAjeerCode: user.ajeerCode,
        targetType: 'user',
        targetId: String(user._id),
        unitPath: user.unitPath,
        details: { mobile: maskMobile(typed) },
      });
      throw mobilePending();
    } else if (typed !== user.mobile) {
      await failed('mobile_mismatch');
      throw new AppError(401, 'MOBILE_MISMATCH', 'Mobile number does not match');
    }
  }
  if (user.mobileVerified === false) {
    await failed('mobile_pending');
    throw mobilePending();
  }

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  await audit({
    action: 'LOGIN',
    actorId: String(user._id),
    actorAjeerCode: user.ajeerCode,
    unitPath: user.unitPath,
    details: { ip },
  });

  const authUser: AuthUser = {
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
    permissions: user.permissions ?? [],
    ...(user.department ? { department: user.department } : {}),
  };
  return authUser;
}

let dummy: Promise<string> | undefined;
/** A bcrypt hash of nothing anybody can type, made once per instance. */
const dummyHash = () => (dummy ??= bcrypt.hash(`no-user-${Math.random()}`, BCRYPT_COST));

const mobilePending = () =>
  new AppError(403, 'MOBILE_PENDING', 'Mobile number waits for District confirmation');

export async function changePassword(
  user: AuthUser,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword === user.ajeerCode) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Password must not equal the ajeer code', {
      field: 'newPassword',
      reason: 'EQUALS_AJEER_CODE',
    });
  }
  if (newPassword === INITIAL_PASSWORD) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Password must not be the initial password', {
      field: 'newPassword',
      reason: 'INITIAL_PASSWORD',
    });
  }
  const doc = await User.findById(user.id).select('+passwordHash').lean();
  if (!doc || !(await bcrypt.compare(currentPassword, doc.passwordHash))) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Current password is incorrect', {
      field: 'currentPassword',
      reason: 'WRONG_CURRENT_PASSWORD',
    });
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await User.updateOne({ _id: doc._id }, { $set: { passwordHash, mustChangePassword: false } });
  await audit({
    action: 'PASSWORD_CHANGE',
    actorId: user.id,
    actorAjeerCode: user.ajeerCode,
    targetType: 'user',
    targetId: user.id,
    unitPath: user.unitPath,
  });
}

/**
 * "پاس ورڈ بھول گئے؟" — when ajeer code + registered mobile match an active user, open a reset
 * request for the supervisors above them. The caller always gets the same answer, so the
 * endpoint cannot be used to find out which codes or numbers exist.
 */
export async function requestPasswordReset(ajeerCode: string, mobile: string): Promise<void> {
  await connectDb();
  const user = await User.findOne({ ajeerCode, isActive: true })
    .select('ajeerCode name nameUr role unitCode unitPath mobile mobileVerified')
    .lean();
  // A self-entered number still waiting for the District is not a registered number.
  if (!user?.mobile || user.mobileVerified === false) return;
  if (normalizeMobile(mobile) !== user.mobile) return;

  const existing = await PasswordResetRequest.exists({ userId: user._id, status: 'pending' });
  if (existing) return;
  await PasswordResetRequest.create({
    userId: user._id,
    ajeerCode: user.ajeerCode,
    name: user.name,
    nameUr: user.nameUr,
    role: user.role,
    unitCode: user.unitCode,
    unitPath: user.unitPath,
    status: 'pending',
    requestedAt: new Date(),
  });
  await audit({
    action: 'PASSWORD_RESET_REQUEST',
    actorId: String(user._id),
    actorAjeerCode: user.ajeerCode,
    targetType: 'user',
    targetId: String(user._id),
    unitPath: user.unitPath,
  });
}

/** Set the initial password again and force a change on next login (supervisor reset). */
export async function resetToInitialPassword(
  actor: AuthUser,
  target: { _id: Types.ObjectId; ajeerCode: string; unitPath: string },
): Promise<void> {
  const passwordHash = await bcrypt.hash(INITIAL_PASSWORD, BCRYPT_COST);
  // Bumping sessionVersion ends every session issued before the reset (CTO 5 Nov 2026).
  await User.updateOne(
    { _id: target._id },
    { $set: { passwordHash, mustChangePassword: true }, $inc: { sessionVersion: 1 } },
  );
  const closed = await PasswordResetRequest.updateMany(
    { userId: target._id, status: 'pending' },
    { $set: { status: 'done', resolvedAt: new Date(), resolvedBy: new Types.ObjectId(actor.id) } },
  );
  await audit({
    action: 'PASSWORD_RESET',
    actorId: actor.id,
    actorAjeerCode: actor.ajeerCode,
    targetType: 'user',
    targetId: String(target._id),
    unitPath: target.unitPath,
    details: { targetAjeerCode: target.ajeerCode, fromRequest: closed.modifiedCount > 0 },
  });
}
