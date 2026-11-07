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

/** A pakistan account of the Central IT Department holding VERIFY_PAKISTAN_MOBILE (CTO 6 Nov 2026). */
export function isCentralItVerifier(caller: AuthUser): boolean {
  return (
    caller.role === 'pakistan' &&
    caller.department === 'CENTRAL_IT' &&
    (caller.permissions ?? []).includes('VERIFY_PAKISTAN_MOBILE')
  );
}

/** Users in the caller's subtree whose role is below the caller's (API: GET /users). */
export type MobileStatus = 'verified' | 'unverified' | 'none';
/** `change` = has a requested new number waiting for its verifier (list filter only). */
export type MobileFilter = MobileStatus | 'change';

export function mobileStatusOf(u: {
  mobile?: string | null;
  mobileVerified?: boolean | null;
}): MobileStatus {
  if (!u.mobile) return 'none';
  return u.mobileVerified === false ? 'unverified' : 'verified';
}

const MOBILE_FILTER: Record<MobileFilter, Record<string, unknown>> = {
  change: { mobileChange: { $exists: true } },
  none: { mobile: { $exists: false } },
  unverified: { mobile: { $exists: true }, mobileVerified: false },
  verified: { mobile: { $exists: true }, mobileVerified: { $ne: false } },
};

export async function listUsers(
  caller: AuthUser,
  opts: { unit?: string; q?: string; mobileStatus?: MobileFilter },
) {
  await connectDb();

  let scope = scopeFilter(caller);
  if (opts.unit) {
    const unit = await Unit.findOne({ code: opts.unit }).select('path').lean();
    assertInScope(caller, unit && { unitPath: unit.path });
    scope = scopeFilter({ unitPath: unit.path });
  }

  // The designated Central IT verifier also sees other pakistan accounts — only in the list of
  // numbers waiting for confirmation (it verifies them; it manages nothing else about them).
  const roles: Role[] = lowerRoles(caller);
  if (
    (opts.mobileStatus === 'unverified' || opts.mobileStatus === 'change') &&
    isCentralItVerifier(caller)
  )
    roles.push('pakistan');
  const filter: Record<string, unknown> = {
    ...scope,
    _id: { $ne: new Types.ObjectId(caller.id) },
    role: { $in: roles },
    ...(opts.mobileStatus ? MOBILE_FILTER[opts.mobileStatus] : {}),
  };
  if (opts.q) {
    const re = { $regex: escapeRegex(opts.q), $options: 'i' };
    filter.$or = [{ name: re }, { nameUr: re }, { ajeerCode: re }];
  }

  const users = await User.find(filter)
    .select(
      'ajeerCode ajeerCodeFull name nameUr fatherName mobile mobileVerified mobileChange role zimmedari unitCode isActive mustChangePassword lastLoginAt',
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
    mobileChange: u.mobileChange
      ? { mobile: maskMobile(u.mobileChange.mobile), requestedAt: u.mobileChange.requestedAt }
      : null,
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

/**
 * Who verifies a self-entered mobile (CTO 5–6 Nov 2026), enforced here for the full number,
 * confirm and reject:
 *   zimmedar ← District · district ← Division · division ← Suba ·
 *   suba ← a pakistan account with the designated permission VERIFY_SUBA_MOBILE only ·
 *   pakistan ← the designated Central IT verifier only: a pakistan account of the Central IT
 *   Department (users.department CENTRAL_IT) that also holds VERIFY_PAKISTAN_MOBILE.
 * Neither the role nor the department alone is enough. Never self; never same level (the Central
 * IT verifier is the one designated exception for pakistan accounts); never a higher level that is
 * not the designated one. Permissions and department are re-read on every request, so a revoke
 * stops the next action at once.
 */
export function assertVerifierOf(caller: AuthUser, target: { _id: unknown; role: Role }): void {
  if (String(target._id) === caller.id) {
    throw new AppError(403, 'FORBIDDEN', 'Nobody verifies their own mobile number');
  }
  if (target.role === 'pakistan') {
    if (!isCentralItVerifier(caller)) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Only the designated Central IT verifier verifies a pakistan account’s mobile number',
      );
    }
    return;
  }
  if (target.role === 'suba') {
    if (caller.role !== 'pakistan' || !caller.permissions?.includes('VERIFY_SUBA_MOBILE')) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Only the designated Pakistan Admin verifies a suba account’s mobile number',
      );
    }
    return;
  }
  if (ROLE_RANK[caller.role] !== ROLE_RANK[target.role] + 1) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Only the level directly above verifies this mobile number',
    );
  }
}

/** The account whose self-entered mobile the caller wants to see / confirm / reject. */
async function loadForVerification(caller: AuthUser, userId: string) {
  const target = Types.ObjectId.isValid(userId)
    ? await User.findById(userId).select('ajeerCode role unitPath mobile mobileVerified').lean()
    : null;
  assertInScope(caller, target);
  assertVerifierOf(caller, target);
  return target;
}

/** The account's verifier (assertVerifierOf) confirms a number typed at the first login. Audit MOBILE_CONFIRM. */
export async function confirmMobile(caller: AuthUser, userId: string): Promise<void> {
  await connectDb();
  const target = await loadForVerification(caller, userId);
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
 * The account's verifier (assertVerifierOf) rejects a number typed at the first login: the number is removed (the
 * user types the right one at the next login) and any session ends. Audit MOBILE_REJECT.
 */
export async function rejectMobile(caller: AuthUser, userId: string): Promise<void> {
  await connectDb();
  const target = await loadForVerification(caller, userId);
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
 * The full self-entered number, for the account's verifier (see assertVerifierOf), which has to
 * check it with the employee before confirming (CTO 5 Nov 2026). Only for a user in its scope whose
 * number is still pending. Audit MOBILE_VIEW (who, when — the log keeps the number masked).
 */
export async function viewPendingMobile(caller: AuthUser, userId: string): Promise<string> {
  await connectDb();
  const target = await loadForVerification(caller, userId);
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

/** The account whose requested mobile change the caller wants to see / confirm / reject. */
async function loadForMobileChange(caller: AuthUser, userId: string) {
  await connectDb();
  const target = Types.ObjectId.isValid(userId)
    ? await User.findById(userId).select('ajeerCode role unitPath mobile mobileChange').lean()
    : null;
  assertInScope(caller, target);
  assertVerifierOf(caller, target);
  if (!target.mobileChange) {
    throw new AppError(409, 'CONFLICT', 'This user has no mobile change waiting for confirmation');
  }
  return { ...target, mobileChange: target.mobileChange };
}

/**
 * GET /users/:id/pending-mobile-change — the full requested number, for the user's verifier, who
 * checks it with the employee before confirming. Audit MOBILE_CHANGE_VIEW (number masked).
 */
export async function viewMobileChange(caller: AuthUser, userId: string): Promise<string> {
  const target = await loadForMobileChange(caller, userId);
  await audit({
    action: 'MOBILE_CHANGE_VIEW',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'user',
    targetId: String(target._id),
    unitPath: target.unitPath,
    details: { targetAjeerCode: target.ajeerCode, to: maskMobile(target.mobileChange.mobile) },
  });
  return target.mobileChange.mobile;
}

/**
 * POST /users/:id/confirm-mobile-change — the verifier confirms: the requested number becomes the
 * registered (verified) mobile. Only the request the screen saw (same number) is confirmed.
 * Audit MOBILE_CHANGE_CONFIRM with both numbers masked.
 */
export async function confirmMobileChange(caller: AuthUser, userId: string): Promise<void> {
  const target = await loadForMobileChange(caller, userId);
  const done = await User.updateOne(
    { _id: target._id, 'mobileChange.mobile': target.mobileChange.mobile },
    {
      $set: { mobile: target.mobileChange.mobile, mobileVerified: true },
      $unset: { mobileChange: 1 },
    },
  );
  if (done.modifiedCount === 0) {
    throw new AppError(409, 'CONFLICT', 'The request changed meanwhile — load the list again');
  }
  await audit({
    action: 'MOBILE_CHANGE_CONFIRM',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'user',
    targetId: String(target._id),
    unitPath: target.unitPath,
    details: {
      targetAjeerCode: target.ajeerCode,
      from: maskMobile(target.mobile),
      to: maskMobile(target.mobileChange.mobile),
    },
  });
}

/**
 * POST /users/:id/reject-mobile-change — the verifier rejects: the request is removed and the
 * registered number stays. Audit MOBILE_CHANGE_REJECT.
 */
export async function rejectMobileChange(caller: AuthUser, userId: string): Promise<void> {
  const target = await loadForMobileChange(caller, userId);
  const done = await User.updateOne(
    { _id: target._id, 'mobileChange.mobile': target.mobileChange.mobile },
    { $unset: { mobileChange: 1 } },
  );
  if (done.modifiedCount === 0) {
    throw new AppError(409, 'CONFLICT', 'The request changed meanwhile — load the list again');
  }
  await audit({
    action: 'MOBILE_CHANGE_REJECT',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'user',
    targetId: String(target._id),
    unitPath: target.unitPath,
    details: { targetAjeerCode: target.ajeerCode, to: maskMobile(target.mobileChange.mobile) },
  });
}
