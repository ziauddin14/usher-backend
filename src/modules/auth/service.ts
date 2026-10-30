import bcrypt from 'bcryptjs';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';

export const BCRYPT_COST = 10;

export interface PublicUser {
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
  if (!unit) throw new AppError(500, 'INTERNAL', 'User unit missing');
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
  };
}

/** Check Ajeer Code + password. Every attempt is audit-logged (never the password). */
export async function login(ajeerCode: string, password: string, ip: string | undefined) {
  await connectDb();
  const user = await User.findOne({ ajeerCode }).select('+passwordHash').lean();
  const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;

  if (!user || !ok) {
    await audit({
      action: 'LOGIN_FAILED',
      ...(user ? { actorId: String(user._id), unitPath: user.unitPath } : {}),
      actorAjeerCode: ajeerCode,
      details: { reason: user ? 'wrong_password' : 'unknown_code', ip },
    });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Ajeer code or password is incorrect');
  }
  if (!user.isActive) {
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is not active');
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
  };
  return authUser;
}

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
