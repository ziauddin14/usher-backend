import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { maskMobile } from '../../lib/mobile.js';
import { assertInScope, escapeRegex, scopeFilter } from '../../lib/scope.js';
import { PasswordResetRequest } from '../../models/password-reset-request.js';
import { Unit } from '../../models/unit.js';
import { ROLE_RANK, ROLES, type Role, User } from '../../models/user.js';
import { resetToInitialPassword } from '../auth/service.js';

function lowerRoles(caller: AuthUser): Role[] {
  return ROLES.filter((r) => ROLE_RANK[r] < ROLE_RANK[caller.role]);
}

/** Users in the caller's subtree whose role is below the caller's (API: GET /users). */
export type MobileStatus = 'verified' | 'unverified' | 'none';

export function mobileStatusOf(u: {
  mobile?: string | null;
  mobileVerified?: boolean | null;
}): MobileStatus {
  if (!u.mobile) return 'none';
  return u.mobileVerified === false ? 'unverified' : 'verified';
}

const MOBILE_FILTER: Record<MobileStatus, Record<string, unknown>> = {
  none: { mobile: { $exists: false } },
  unverified: { mobile: { $exists: true }, mobileVerified: false },
  verified: { mobile: { $exists: true }, mobileVerified: { $ne: false } },
};

export async function listUsers(
  caller: AuthUser,
  opts: { unit?: string; q?: string; mobileStatus?: MobileStatus },
) {
  await connectDb();

  let scope = scopeFilter(caller);
  if (opts.unit) {
    const unit = await Unit.findOne({ code: opts.unit }).select('path').lean();
    assertInScope(caller, unit && { unitPath: unit.path });
    scope = scopeFilter({ unitPath: unit.path });
  }

  const filter: Record<string, unknown> = {
    ...scope,
    role: { $in: lowerRoles(caller) },
    ...(opts.mobileStatus ? MOBILE_FILTER[opts.mobileStatus] : {}),
  };
  if (opts.q) {
    const re = { $regex: escapeRegex(opts.q), $options: 'i' };
    filter.$or = [{ name: re }, { nameUr: re }, { ajeerCode: re }];
  }

  const users = await User.find(filter)
    .select(
      'ajeerCode ajeerCodeFull name nameUr fatherName mobile mobileVerified role zimmedari unitCode isActive mustChangePassword lastLoginAt',
    )
    .sort({ unitCode: 1, ajeerCode: 1 })
    .limit(500)
    .lean();

  return users.map((u) => ({
    id: String(u._id),
    ajeerCode: u.ajeerCode,
    ajeerCodeFull: u.ajeerCodeFull,
    name: u.name,
    nameUr: u.nameUr,
    fatherName: u.fatherName,
    mobile: maskMobile(u.mobile),
    mobileStatus: mobileStatusOf(u),
    role: u.role,
    zimmedari: u.zimmedari,
    unitCode: u.unitCode,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt,
  }));
}

/** Open "forgot password" requests of users below the caller, in scope (oldest first). */
export async function listResetRequests(caller: AuthUser) {
  await connectDb();
  const requests = await PasswordResetRequest.find({
    ...scopeFilter(caller),
    status: 'pending',
    role: { $in: lowerRoles(caller) },
  })
    .sort({ requestedAt: 1 })
    .limit(200)
    .lean();
  return requests.map((r) => ({
    id: String(r._id),
    userId: String(r.userId),
    ajeerCode: r.ajeerCode,
    name: r.name,
    nameUr: r.nameUr,
    role: r.role,
    unitCode: r.unitCode,
    requestedAt: r.requestedAt,
  }));
}

/**
 * Supervisor resets a lower-level user in scope: password back to the initial one and a forced
 * change (with the mobile check) on next login. Closes any open request. Audit PASSWORD_RESET.
 */
export async function resetPassword(caller: AuthUser, userId: string): Promise<void> {
  await connectDb();
  const target = Types.ObjectId.isValid(userId)
    ? await User.findById(userId).select('ajeerCode role unitPath').lean()
    : null;
  assertInScope(caller, target);
  if (ROLE_RANK[target.role] >= ROLE_RANK[caller.role]) {
    throw new AppError(403, 'FORBIDDEN', 'Only users below your level can be reset');
  }
  await resetToInitialPassword(caller, target);
}

/** District (or above) confirms a number the user typed at the first login. Audit MOBILE_CONFIRM. */
export async function confirmMobile(caller: AuthUser, userId: string): Promise<void> {
  await connectDb();
  const target = Types.ObjectId.isValid(userId)
    ? await User.findById(userId).select('ajeerCode role unitPath mobile mobileVerified').lean()
    : null;
  assertInScope(caller, target);
  if (ROLE_RANK[target.role] >= ROLE_RANK[caller.role]) {
    throw new AppError(403, 'FORBIDDEN', 'Only users below your level can be confirmed');
  }
  if (!target.mobile) throw new AppError(409, 'CONFLICT', 'This user has no mobile number yet');
  if (target.mobileVerified !== false) {
    throw new AppError(409, 'CONFLICT', 'This mobile number is already confirmed');
  }
  const done = await User.updateOne(
    { _id: target._id, mobile: target.mobile, mobileVerified: false },
    { $set: { mobileVerified: true } },
  );
  if (done.modifiedCount === 0) {
    throw new AppError(409, 'CONFLICT', 'The number changed meanwhile — load the list again');
  }
  await audit({
    action: 'MOBILE_CONFIRM',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'user',
    targetId: String(target._id),
    unitPath: target.unitPath,
    details: { targetAjeerCode: target.ajeerCode, mobile: maskMobile(target.mobile) },
  });
}

/**
 * District (or above) rejects a number the user typed at the first login: the number is removed
 * (the user types the right one at the next login) and any session ends. Audit MOBILE_REJECT.
 */
export async function rejectMobile(caller: AuthUser, userId: string): Promise<void> {
  await connectDb();
  const target = Types.ObjectId.isValid(userId)
    ? await User.findById(userId).select('ajeerCode role unitPath mobile mobileVerified').lean()
    : null;
  assertInScope(caller, target);
  if (ROLE_RANK[target.role] >= ROLE_RANK[caller.role]) {
    throw new AppError(403, 'FORBIDDEN', 'Only users below your level can be rejected');
  }
  if (!target.mobile || target.mobileVerified !== false) {
    throw new AppError(409, 'CONFLICT', 'This user has no mobile number waiting for confirmation');
  }
  const done = await User.updateOne(
    { _id: target._id, mobile: target.mobile, mobileVerified: false },
    { $unset: { mobile: 1, mobileVerified: 1 }, $inc: { sessionVersion: 1 } },
  );
  if (done.modifiedCount === 0) {
    throw new AppError(409, 'CONFLICT', 'The number changed meanwhile — load the list again');
  }
  await audit({
    action: 'MOBILE_REJECT',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'user',
    targetId: String(target._id),
    unitPath: target.unitPath,
    details: { targetAjeerCode: target.ajeerCode, mobile: maskMobile(target.mobile) },
  });
}

/**
 * The full self-entered number, for the District that has to check it with the employee before
 * confirming (CTO 5 Nov 2026). Only a district user, only for a lower-level user in its scope whose
 * number is still pending. Audit MOBILE_VIEW (who, when — the log keeps the number masked).
 */
export async function viewPendingMobile(caller: AuthUser, userId: string): Promise<string> {
  if (caller.role !== 'district') {
    throw new AppError(403, 'FORBIDDEN', 'Only the District sees a full pending number');
  }
  await connectDb();
  const target = Types.ObjectId.isValid(userId)
    ? await User.findById(userId).select('ajeerCode role unitPath mobile mobileVerified').lean()
    : null;
  assertInScope(caller, target);
  if (ROLE_RANK[target.role] >= ROLE_RANK[caller.role]) {
    throw new AppError(403, 'FORBIDDEN', 'Only users below your level');
  }
  if (!target.mobile || target.mobileVerified !== false) {
    throw new AppError(409, 'CONFLICT', 'This user has no mobile number waiting for confirmation');
  }
  await audit({
    action: 'MOBILE_VIEW',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'user',
    targetId: String(target._id),
    unitPath: target.unitPath,
    details: { targetAjeerCode: target.ajeerCode, mobile: maskMobile(target.mobile) },
  });
  return target.mobile;
}

/**
 * POST /users/:id/status { isActive } — a supervisor activates / deactivates a lower-level user in
 * scope. A deactivated user's sessions stop at once (every request re-reads isActive). Audit
 * USER_STATUS.
 */
export async function setUserStatus(caller: AuthUser, userId: string, isActive: boolean) {
  await connectDb();
  const target = Types.ObjectId.isValid(userId)
    ? await User.findById(userId).select('ajeerCode role unitPath isActive').lean()
    : null;
  assertInScope(caller, target);
  if (ROLE_RANK[target.role] >= ROLE_RANK[caller.role]) {
    throw new AppError(403, 'FORBIDDEN', 'Only users below your level');
  }
  if (target.isActive === isActive) return;
  await User.updateOne({ _id: target._id }, { $set: { isActive } });
  await audit({
    action: 'USER_STATUS',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'user',
    targetId: String(target._id),
    unitPath: target.unitPath,
    details: { targetAjeerCode: target.ajeerCode, isActive },
  });
}
