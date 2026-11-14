// Controlled provisioning of a Pakistan Admin account (CTO 6 Nov 2026):
//   1. an authorized central management authority nominates the person,
//   2. the nomination is confirmed through an authorized administrative process,
//   3. Central IT creates the account by hand with scripts/provision-pakistan-admin.ts.
// The account gets the pakistan role, the national unit, the initial password and a forced change —
// and nothing else: no mobile (optional; the person adds it in their profile). It never promotes an
// existing account, and no employee import can create or change a pakistan-level account.
// Every creation is audited (USER_PROVISION) with both document references and the operator.
import bcrypt from 'bcryptjs';
import { audit } from '../../lib/audit.js';
import { connectDb } from '../../lib/db.js';
import { Unit } from '../../models/unit.js';
import { type Department, isCentrallyManaged, User } from '../../models/user.js';
import { INITIAL_PASSWORD } from '../auth/schemas.js';
import { BCRYPT_COST } from '../auth/service.js';

export interface ProvisionInput {
  ajeerCode: string;
  name: string;
  nameUr?: string;
  /** Reference of the central management authority's nomination (document / letter number). */
  nominationRef: string;
  /** Reference of the administrative confirmation of that nomination. */
  approvalRef: string;
  /** Who in Central IT provisions it (recorded as the audit actor). */
  operator: string;
  /** CENTRAL_IT only for a Central IT Department account; absent for any other Pakistan Admin. */
  department?: Department;
  /**
   * 'pakistan' (default): views everything. 'admin' (CTO 14 Nov 2026): the only role that changes
   * data — users, Gaon, jadwal corrections, official duty, the ERP upload.
   */
  role?: 'pakistan' | 'admin';
}

export type ProvisionResult =
  | { ok: true; id: string; ajeerCode: string }
  | {
      ok: false;
      reason: 'INVALID' | 'EXISTS' | 'NO_PAKISTAN_UNIT';
      message: string;
    };

const REF = /^[\p{L}\p{N} ./_#:()-]{3,100}$/u;

/** Create one Pakistan Admin account (never update one). Audit USER_PROVISION. */
export async function provisionPakistanAdmin(input: ProvisionInput): Promise<ProvisionResult> {
  const invalid = (message: string): ProvisionResult => ({ ok: false, reason: 'INVALID', message });
  if (!/^\d{3,9}$/.test(input.ajeerCode)) return invalid('ajeerCode must be 3–9 digits');
  if (input.name.trim().length < 2 || input.name.length > 100) return invalid('name is required');
  if (!REF.test(input.nominationRef.trim())) return invalid('nomination reference is required');
  if (!REF.test(input.approvalRef.trim())) return invalid('approval reference is required');
  if (input.nominationRef.trim() === input.approvalRef.trim()) {
    return invalid('nomination and its confirmation are separate documents');
  }
  if (!/^[\p{L}\p{N} ._-]{2,60}$/u.test(input.operator.trim())) {
    return invalid('operator is required');
  }

  await connectDb();
  if (await User.exists({ ajeerCode: input.ajeerCode })) {
    return {
      ok: false,
      reason: 'EXISTS',
      message: 'An account with this ajeer code already exists — provisioning never promotes one',
    };
  }
  // The national unit by its code (a test sandbox root TEST is also level pakistan).
  const unit = await Unit.findOne({ code: 'PK', level: 'pakistan' }).select('code path').lean();
  if (!unit) {
    return { ok: false, reason: 'NO_PAKISTAN_UNIT', message: 'The national unit does not exist' };
  }

  const at = new Date();
  const user = await User.create({
    ajeerCode: input.ajeerCode,
    name: input.name.trim(),
    ...(input.nameUr?.trim() ? { nameUr: input.nameUr.trim() } : {}),
    role: input.role ?? 'pakistan',
    unitCode: unit.code,
    unitPath: unit.path,
    passwordHash: await bcrypt.hash(INITIAL_PASSWORD, BCRYPT_COST),
    mustChangePassword: true,
    isActive: true,
    ...(input.department ? { department: input.department } : {}),
    provisioned: {
      nominationRef: input.nominationRef.trim(),
      approvalRef: input.approvalRef.trim(),
      operator: input.operator.trim(),
      at,
    },
    isDemo: false,
  });
  await audit({
    action: 'USER_PROVISION',
    actorAjeerCode: input.operator.trim(),
    targetType: 'user',
    targetId: String(user._id),
    unitPath: unit.path,
    details: {
      targetAjeerCode: input.ajeerCode,
      role: input.role ?? 'pakistan',
      department: input.department ?? null,
      nominationRef: input.nominationRef.trim(),
      approvalRef: input.approvalRef.trim(),
      isActive: true,
    },
  });
  return { ok: true, id: String(user._id), ajeerCode: input.ajeerCode };
}

export type StatusResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'INVALID' | 'NOT_FOUND' | 'NOT_CENTRAL'; message: string };

/**
 * Activate / deactivate a Pakistan Admin account (CTO 6 Nov 2026: activation changes are audited).
 * No API can do it (the rank rule lets nobody change a pakistan account), so it is part of Central
 * IT's controlled process, with the operator and the decision reference. A deactivated account's
 * sessions stop at its next request (every request re-reads isActive). Audit USER_STATUS.
 */
export async function setPakistanAdminActive(input: {
  ajeerCode: string;
  isActive: boolean;
  operator: string;
  reference: string;
}): Promise<StatusResult> {
  const invalid = (message: string): StatusResult => ({ ok: false, reason: 'INVALID', message });
  if (!/^\d{3,9}$/.test(input.ajeerCode)) return invalid('ajeerCode must be 3–9 digits');
  if (!REF.test(input.reference.trim())) return invalid('decision reference is required');
  if (!/^[\p{L}\p{N} ._-]{2,60}$/u.test(input.operator.trim())) {
    return invalid('operator is required');
  }
  await connectDb();
  const user = await User.findOne({ ajeerCode: input.ajeerCode })
    .select('ajeerCode role department provisioned unitPath isActive')
    .lean();
  if (!user) return { ok: false, reason: 'NOT_FOUND', message: 'No account with this ajeer code' };
  if (!isCentrallyManaged(user)) {
    return {
      ok: false,
      reason: 'NOT_CENTRAL',
      message: 'Not a Pakistan Admin account — its supervisors manage it on the dashboard',
    };
  }
  if (user.isActive === input.isActive) return { ok: true, changed: false };
  // Deactivation also bumps sessionVersion: every token issued before it stays invalid even after
  // a later re-activation (the person logs in again).
  await User.updateOne(
    { _id: user._id },
    input.isActive
      ? { $set: { isActive: true } }
      : { $set: { isActive: false }, $inc: { sessionVersion: 1 } },
  );
  await audit({
    action: 'USER_STATUS',
    actorAjeerCode: input.operator.trim(),
    targetType: 'user',
    targetId: String(user._id),
    unitPath: user.unitPath,
    details: {
      targetAjeerCode: user.ajeerCode,
      isActive: input.isActive,
      reference: input.reference.trim(),
    },
  });
  return { ok: true, changed: true };
}
