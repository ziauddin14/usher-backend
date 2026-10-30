import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { assertInScope, escapeRegex, scopeFilter } from '../../lib/scope.js';
import { Unit } from '../../models/unit.js';
import { ROLE_RANK, ROLES, User } from '../../models/user.js';

/** Users in the caller's subtree whose role is below the caller's (API: GET /users). */
export async function listUsers(caller: AuthUser, opts: { unit?: string; q?: string }) {
  await connectDb();

  let scope = scopeFilter(caller);
  if (opts.unit) {
    const unit = await Unit.findOne({ code: opts.unit }).select('path').lean();
    assertInScope(caller, unit && { unitPath: unit.path });
    scope = scopeFilter({ unitPath: unit.path });
  }

  const lowerRoles = ROLES.filter((r) => ROLE_RANK[r] < ROLE_RANK[caller.role]);
  const filter: Record<string, unknown> = { ...scope, role: { $in: lowerRoles } };
  if (opts.q) {
    const re = { $regex: escapeRegex(opts.q), $options: 'i' };
    filter.$or = [{ name: re }, { nameUr: re }, { ajeerCode: re }];
  }

  const users = await User.find(filter)
    .select('ajeerCode name nameUr role zimmedari unitCode isActive lastLoginAt')
    .sort({ unitCode: 1, ajeerCode: 1 })
    .limit(500)
    .lean();

  return users.map((u) => ({
    id: String(u._id),
    ajeerCode: u.ajeerCode,
    name: u.name,
    nameUr: u.nameUr,
    role: u.role,
    zimmedari: u.zimmedari,
    unitCode: u.unitCode,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
  }));
}
