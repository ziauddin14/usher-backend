import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { assertInScope, isInScope, scopeFilter } from '../../lib/scope.js';
import { Unit, type UnitLevel } from '../../models/unit.js';
import { User } from '../../models/user.js';

/**
 * Extra view access (CTO 17 Nov 2026): a District / Division / Suba zimmedar may be given more units
 * of their own level besides their own — e.g. a Division zimmedar holding a second Division as an
 * honorary charge. They see those units exactly like their own (dashboard, Gaon list, reports,
 * Excel / PDF, WhatsApp share); like their own unit, view only. Only the Admin sets it (audited).
 */
export const EXTRA_UNIT_ROLES = ['district', 'division', 'suba'] as const;
type ExtraRole = (typeof EXTRA_UNIT_ROLES)[number];
const MAX_EXTRA_UNITS = 5;

const codeOf = (path: string) => path.split('/').pop()!;

const isExtraRole = (role: string): role is ExtraRole =>
  (EXTRA_UNIT_ROLES as readonly string[]).includes(role);

/** GET /users/units?level — the units of one level in the Admin's scope, to choose from. */
export async function listUnits(caller: AuthUser, level: UnitLevel) {
  await connectDb();
  const units = await Unit.find({ level, isActive: { $ne: false }, ...scopeFilter(caller, 'path') })
    .select('code name nameUr path')
    .sort({ name: 1 })
    .lean();
  return units.map((u) => ({
    code: u.code,
    name: u.name,
    nameUr: u.nameUr ?? null,
    // The Suba / Division above it, so two units of the same name can be told apart.
    parentCode: u.path.split('/').slice(-2, -1)[0] ?? null,
  }));
}

/**
 * PUT /users/:id/extra-units { unitCodes } — replaces the user's extra units (an empty list removes
 * all). Each unit must be active, in the Admin's scope, of the user's own level and not the user's
 * own unit. Audit USER_EXTRA_UNITS with the codes before and after.
 */
export async function setExtraUnits(caller: AuthUser, userId: string, unitCodes: string[]) {
  await connectDb();
  const target = Types.ObjectId.isValid(userId)
    ? await User.findById(userId).select('ajeerCode role unitCode unitPath extraUnitPaths').lean()
    : null;
  assertInScope(caller, target);
  if (!isExtraRole(target.role)) {
    throw new AppError(
      400,
      'EXTRA_UNITS_NOT_ALLOWED',
      'Extra units are only for District, Division and Suba users',
    );
  }
  const codes = [...new Set(unitCodes)].filter((c) => c !== target.unitCode);
  if (codes.length > MAX_EXTRA_UNITS) {
    throw new AppError(400, 'VALIDATION_FAILED', `At most ${MAX_EXTRA_UNITS} extra units`);
  }
  const units = codes.length
    ? await Unit.find({ code: { $in: codes } })
        .select('code name nameUr level path isActive')
        .lean()
    : [];
  const bad = codes.filter((c) => {
    const u = units.find((x) => x.code === c);
    return !u || u.isActive === false || u.level !== target.role || !isInScope(caller, u.path);
  });
  if (bad.length) {
    throw new AppError(400, 'EXTRA_UNIT_INVALID', 'Unit is not a unit of the same level', {
      codes: bad,
    });
  }
  const before = (target.extraUnitPaths ?? []).map(codeOf);
  const paths = codes.map((c) => units.find((u) => u.code === c)!.path);
  await User.updateOne(
    { _id: target._id },
    paths.length ? { $set: { extraUnitPaths: paths } } : { $unset: { extraUnitPaths: 1 } },
  );
  await audit({
    action: 'USER_EXTRA_UNITS',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'user',
    targetId: String(target._id),
    unitPath: target.unitPath,
    details: { targetAjeerCode: target.ajeerCode, before, after: codes },
  });
  return {
    extraUnits: codes.map((c) => {
      const u = units.find((x) => x.code === c)!;
      return { code: u.code, name: u.name, nameUr: u.nameUr ?? null, level: u.level };
    }),
  };
}
