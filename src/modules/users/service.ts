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

/**
 * GET /users — users in the caller's subtree whose role is below the caller's. The optional
 * profile mobile is shown masked; it needs no verification (CTO 7 Nov 2026).
 */
export async function listUsers(caller: AuthUser, opts: { unit?: string; q?: string }) {
  await connectDb();

  let scope = scopeFilter(caller);
  if (opts.unit) {
    const unit = await Unit.findOne({ code: opts.unit }).select('path').lean();
    assertInScope(caller, unit && { unitPath: unit.path });
    scope = scopeFilter({ unitPath: unit.path });
  }

  const filter: Record<string, unknown> = {
    ...scope,
    _id: { $ne: new Types.ObjectId(caller.id) },
    role: { $in: lowerRoles(caller) },
  };
  if (opts.q) {
    const re = { $regex: escapeRegex(opts.q), $options: 'i' };
    filter.$or = [{ name: re }, { nameUr: re }, { ajeerCode: re }];
  }

  const users = await User.find(filter)
    .select(
      'ajeerCode ajeerCodeFull name nameUr fatherName mobile role zimmedari unitCode isActive mustChangePassword lastLoginAt',
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
 * change on next login. Closes any open request. Audit PASSWORD_RESET.
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
  // Deactivation bumps sessionVersion, so sessions from before it never come back on re-activation.
  await User.updateOne(
    { _id: target._id },
    isActive
      ? { $set: { isActive: true } }
      : { $set: { isActive: false }, $inc: { sessionVersion: 1 } },
  );
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
