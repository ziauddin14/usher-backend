// Designated permissions (CTO 5 Nov 2026). They are never implied by a role: an operator grants or
// revokes them explicitly with scripts/designate-verifier.ts, and every change is audited.
import { audit } from '../../lib/audit.js';
import { connectDb } from '../../lib/db.js';
import { type Permission, type Role, User } from '../../models/user.js';

/** The only role a permission may be given to. */
const ROLE_FOR: Record<Permission, Role> = { VERIFY_SUBA_MOBILE: 'pakistan' };

export type PermissionChange =
  | { ok: true; changed: boolean; ajeerCode: string }
  | { ok: false; reason: 'NOT_FOUND' | 'WRONG_ROLE' | 'INACTIVE' };

/** Grant (or revoke) one permission on one account. Audit USER_PERMISSION when it changes. */
export async function setPermission(input: {
  ajeerCode: string;
  permission: Permission;
  grant: boolean;
  /** Who ran it, for the audit log (e.g. "cli"). */
  actor: string;
}): Promise<PermissionChange> {
  await connectDb();
  const user = await User.findOne({ ajeerCode: input.ajeerCode })
    .select('ajeerCode role unitPath isActive permissions')
    .lean();
  if (!user) return { ok: false, reason: 'NOT_FOUND' };
  if (input.grant && user.role !== ROLE_FOR[input.permission])
    return { ok: false, reason: 'WRONG_ROLE' };
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
    },
  });
  return { ok: true, changed: true, ajeerCode: user.ajeerCode };
}
