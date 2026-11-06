// Designated permissions (CTO 5–6 Nov 2026). They are never implied by a role or a department: an
// operator grants or revokes them explicitly with scripts/designate-verifier.ts, and every change
// is audited (USER_PERMISSION).
import { audit } from '../../lib/audit.js';
import { connectDb } from '../../lib/db.js';
import { type Department, type Permission, type Role, User } from '../../models/user.js';

/** The only role a permission may be given to. */
const ROLE_FOR: Record<Permission, Role> = {
  VERIFY_SUBA_MOBILE: 'pakistan',
  VERIFY_PAKISTAN_MOBILE: 'pakistan',
};
/** A permission that also needs a department (set only by central provisioning). */
const DEPARTMENT_FOR: Partial<Record<Permission, Department>> = {
  VERIFY_PAKISTAN_MOBILE: 'CENTRAL_IT',
};

export type PermissionChange =
  | { ok: true; changed: boolean; ajeerCode: string }
  | { ok: false; reason: 'NOT_FOUND' | 'WRONG_ROLE' | 'WRONG_DEPARTMENT' | 'INACTIVE' };

/** Grant (or revoke) one permission on one account. Audit USER_PERMISSION when it changes. */
export async function setPermission(input: {
  ajeerCode: string;
  permission: Permission;
  grant: boolean;
  /** Who ran it (the Central IT operator), recorded as the audit actor. */
  actor: string;
  /** The authority's decision / document reference for this designation, kept in the audit. */
  reference?: string;
}): Promise<PermissionChange> {
  await connectDb();
  const user = await User.findOne({ ajeerCode: input.ajeerCode })
    .select('ajeerCode role unitPath isActive permissions department')
    .lean();
  if (!user) return { ok: false, reason: 'NOT_FOUND' };
  if (input.grant && user.role !== ROLE_FOR[input.permission])
    return { ok: false, reason: 'WRONG_ROLE' };
  const department = DEPARTMENT_FOR[input.permission];
  if (input.grant && department && user.department !== department)
    return { ok: false, reason: 'WRONG_DEPARTMENT' };
  if (input.grant && !user.isActive) return { ok: false, reason: 'INACTIVE' };

  const has = (user.permissions ?? []).includes(input.permission);
  if (has === input.grant) return { ok: true, changed: false, ajeerCode: user.ajeerCode };
  await User.updateOne(
    { _id: user._id },
    input.grant
      ? { $addToSet: { permissions: input.permission } }
      : { $pull: { permissions: input.permission } },
  );
  await audit({
    action: 'USER_PERMISSION',
    actorAjeerCode: input.actor,
    targetType: 'user',
    targetId: String(user._id),
    unitPath: user.unitPath,
    details: {
      targetAjeerCode: user.ajeerCode,
      permission: input.permission,
      granted: input.grant,
      ...(input.reference ? { reference: input.reference } : {}),
    },
  });
  return { ok: true, changed: true, ajeerCode: user.ajeerCode };
}
