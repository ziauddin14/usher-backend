import { Types } from 'mongoose';
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
export async function listUsers(caller: AuthUser, opts: { unit?: string; q?: string }) {
  await connectDb();

  let scope = scopeFilter(caller);
  if (opts.unit) {
    const unit = await Unit.findOne({ code: opts.unit }).select('path').lean();
    assertInScope(caller, unit && { unitPath: unit.path });
    scope = scopeFilter({ unitPath: unit.path });
  }

  const filter: Record<string, unknown> = { ...scope, role: { $in: lowerRoles(caller) } };
  if (opts.q) {
    const re = { $regex: escapeRegex(opts.q), $options: 'i' };
    filter.$or = [{ name: re }, { nameUr: re }, { ajeerCode: re }];
  }

  const users = await User.find(filter)
    .select(
      'ajeerCode name nameUr fatherName mobile role zimmedari unitCode isActive mustChangePassword lastLoginAt',
    )
    .sort({ unitCode: 1, ajeerCode: 1 })
    .limit(500)
    .lean();

  return users.map((u) => ({
    id: String(u._id),
    ajeerCode: u.ajeerCode,
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
