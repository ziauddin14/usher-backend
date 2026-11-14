// POST /users — the Admin creates a new zimmedar account (CTO 14 Nov 2026): e.g. a new Ushar
// Zimmedar who joined after the HR import. Initial password demo1234 with a forced change, like
// every new account. Creates only — an existing Ajeer Code is refused (409), never changed.
import bcrypt from 'bcryptjs';
import type { z } from 'zod';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { assertInScope, escapeRegex } from '../../lib/scope.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { INITIAL_PASSWORD } from '../auth/schemas.js';
import { BCRYPT_COST } from '../auth/service.js';
import type { createUserSchema } from './schemas.js';

export async function createZimmedar(caller: AuthUser, body: z.infer<typeof createUserSchema>) {
  await connectDb();
  const unit = await Unit.findOne({ code: body.districtCode, isActive: { $ne: false } })
    .select('code path level')
    .lean();
  assertInScope(caller, unit && { unitPath: unit.path });
  if (unit.level !== 'district') {
    throw new AppError(400, 'VALIDATION_FAILED', 'Choose a district', { field: 'districtCode' });
  }
  if (await User.exists({ ajeerCode: body.ajeerCode })) {
    throw new AppError(409, 'CONFLICT', 'An account with this Ajeer Code already exists', {
      field: 'ajeerCode',
    });
  }
  const user = await User.create({
    ajeerCode: body.ajeerCode,
    name: body.name,
    ...(body.nameUr ? { nameUr: body.nameUr } : {}),
    ...(body.fatherName ? { fatherName: body.fatherName } : {}),
    ...(body.mobile ? { mobile: body.mobile } : {}),
    role: 'zimmedar',
    zimmedari: body.zimmedari,
    unitCode: unit.code,
    unitPath: unit.path,
    passwordHash: await bcrypt.hash(INITIAL_PASSWORD, BCRYPT_COST),
    mustChangePassword: true,
    isActive: true,
    isDemo: false,
  });
  await audit({
    action: 'USER_CREATE',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'user',
    targetId: String(user._id),
    unitPath: unit.path,
    details: { targetAjeerCode: body.ajeerCode, zimmedari: body.zimmedari, unitCode: unit.code },
  });
  return { id: String(user._id), ajeerCode: user.ajeerCode };
}

/** GET /users/districts (Admin): active Districts for the new-zimmedar form, by name. */
export async function listDistricts(caller: AuthUser) {
  await connectDb();
  const units = await Unit.find({
    level: 'district',
    isActive: { $ne: false },
    path: { $regex: `^${escapeRegex(caller.unitPath)}(/|$)` },
  })
    .select('code name nameUr')
    .sort({ name: 1 })
    .lean();
  return units.map((u) => ({ code: u.code, name: u.name, nameUr: u.nameUr ?? null }));
}
