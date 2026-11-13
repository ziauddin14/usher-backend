// District (and above) village management (Step 4): pending list, approve (with a spelling fix),
// merge into an existing village, and assign / transfer to a zimmedar of the village's district.
// Every action is audited; scope is enforced on the village's unit path (404 outside).
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { assertInScope, districtPathOf, scopeFilter } from '../../lib/scope.js';
import { looseVillageKey, villageNameKey } from '../../lib/text.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village, type VillageIssueKind } from '../../models/village.js';

const LIVE: ('approved' | 'pending')[] = ['approved', 'pending'];

async function villageInScope(caller: AuthUser, id: string) {
  await connectDb();
  const village = Types.ObjectId.isValid(id) ? await Village.findById(id) : null;
  assertInScope(caller, village);
  return village;
}

const view = (v: {
  _id: Types.ObjectId;
  name: string;
  status: string;
  districtCode: string;
  assignedTo?: Types.ObjectId | null;
}) => ({
  id: v._id.toHexString(),
  name: v.name,
  status: v.status,
  districtCode: v.districtCode,
  assignedTo: v.assignedTo ? v.assignedTo.toHexString() : null,
});

/** GET /villages/pending — pending villages in scope, oldest first, with who added them. */
export async function listPending(caller: AuthUser) {
  await connectDb();
  const villages = await Village.find({ ...scopeFilter(caller), status: 'pending' })
    .select('name status districtCode assignedTo addedBy createdAt')
    .sort({ createdAt: 1 })
    .limit(300)
    .lean();
  const adders = await User.find({ _id: { $in: villages.map((v) => v.addedBy).filter(Boolean) } })
    .select('ajeerCode name nameUr')
    .lean();
  const byId = new Map(adders.map((u) => [String(u._id), u]));
  return villages.map((v) => {
    const by = v.addedBy ? byId.get(String(v.addedBy)) : undefined;
    return {
      ...view(v),
      addedAt: v.createdAt,
      addedBy: by ? { id: String(by._id), ajeerCode: by.ajeerCode, name: by.name } : null,
    };
  });
}

/** POST /villages/:id/approve { name? } — pending → approved; optional corrected spelling. */
export async function approveVillage(caller: AuthUser, id: string, name?: string) {
  const village = await villageInScope(caller, id);
  if (village.status !== 'pending') throw new AppError(409, 'CONFLICT', 'Village is not pending');
  const from = village.name;
  if (name && name !== village.name) {
    const nameKey = villageNameKey(name);
    const clash = await Village.findOne({
      _id: { $ne: village._id },
      unitPath: village.unitPath,
      nameKey,
      status: { $in: LIVE },
    }).lean();
    if (clash) {
      throw new AppError(409, 'VILLAGE_EXISTS', 'A village with this name already exists', {
        village: { id: String(clash._id), name: clash.name, status: clash.status },
      });
    }
    village.name = name.replace(/\s+/g, ' ').trim();
    village.nameKey = nameKey;
  }
  village.status = 'approved';
  village.approvedBy = new Types.ObjectId(caller.id);
  village.approvedAt = new Date();
  await village.save();
  await audit({
    action: 'VILLAGE_APPROVE',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'village',
    targetId: String(village._id),
    unitPath: village.unitPath,
    details: { name: village.name, ...(from !== village.name ? { renamedFrom: from } : {}) },
  });
  return view(village);
}

/**
 * POST /villages/:id/merge { intoId } — a duplicate becomes `merged` into an approved village of the
 * same district. Visits keep their snapshot name; nothing is deleted.
 */
export async function mergeVillage(caller: AuthUser, id: string, intoId: string) {
  const village = await villageInScope(caller, id);
  if (village.status === 'merged') throw new AppError(409, 'CONFLICT', 'Village is already merged');
  if (id === intoId)
    throw new AppError(400, 'VALIDATION_FAILED', 'Cannot merge a village into itself');
  const into = await villageInScope(caller, intoId);
  if (into.unitPath !== village.unitPath || into.status !== 'approved') {
    throw new AppError(409, 'CONFLICT', 'Merge only into an approved village of the same district');
  }
  village.status = 'merged';
  village.mergedInto = into._id;
  await village.save();
  // The responsible zimmedar of the duplicate keeps the merged village if it had nobody, and the
  // duplicate's spellings stay findable on the surviving village (a later import matches them).
  const now = new Date();
  await Village.updateOne(
    { _id: into._id },
    {
      ...(!into.assignedTo && village.assignedTo
        ? { $set: { assignedTo: village.assignedTo } }
        : {}),
      $push: {
        formerNames: {
          $each: [
            { name: village.name, nameKey: village.nameKey, at: now, reason: 'merge' },
            ...(village.formerNames ?? []).map((f) => ({
              name: f.name,
              nameKey: f.nameKey,
              at: now,
              reason: 'merge' as const,
            })),
          ],
        },
      },
    },
  );
  if (!into.assignedTo && village.assignedTo) into.assignedTo = village.assignedTo;
  await audit({
    action: 'VILLAGE_MERGE',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'village',
    targetId: String(village._id),
    unitPath: village.unitPath,
    details: { name: village.name, into: String(into._id), intoName: into.name },
  });
  return { village: view(village), into: view(into) };
}

/**
 * POST /villages/:id/assign { userId } — give a district-pool village to a zimmedar, or move a
 * village from one zimmedar to another. Only active zimmedaran of the village's own district.
 */
export async function assignVillage(caller: AuthUser, id: string, userId: string) {
  const village = await villageInScope(caller, id);
  if (village.status === 'merged') throw new AppError(409, 'CONFLICT', 'Village is merged');
  const target = Types.ObjectId.isValid(userId)
    ? await User.findOne({ _id: userId, role: 'zimmedar', isActive: true })
        .select('ajeerCode name unitPath')
        .lean()
    : null;
  // A zimmedar of the village's District — directly or under one of its Tehsils.
  if (!target || districtPathOf(target.unitPath) !== village.unitPath) {
    throw new AppError(409, 'CONFLICT', 'Only an active zimmedar of the village’s district');
  }
  const from = village.assignedTo ? String(village.assignedTo) : null;
  if (from === String(target._id)) return view(village);
  village.assignedTo = target._id;
  // Assigned: whatever kept it in the pool is solved (CTO 13 Nov 2026).
  village.set('issues', undefined);
  await village.save();
  const previous = from ? await User.findById(from).select('ajeerCode').lean() : null;
  await audit({
    action: 'VILLAGE_REASSIGN',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'village',
    targetId: String(village._id),
    unitPath: village.unitPath,
    details: {
      name: village.name,
      from: from ? { id: from, ajeerCode: previous?.ajeerCode ?? null } : null,
      to: { id: String(target._id), ajeerCode: target.ajeerCode },
    },
  });
  return view(village);
}

/** A district unit the caller may manage (their own district, or one below them). */
async function districtInScope(caller: AuthUser, code?: string) {
  await connectDb();
  const unit = await Unit.findOne({ code: code ?? caller.unitCode })
    .select('code path level')
    .lean();
  assertInScope(caller, unit && { unitPath: unit.path });
  if (unit.level !== 'district') {
    throw new AppError(400, 'VALIDATION_FAILED', 'Choose a district', { field: 'districtCode' });
  }
  return unit;
}

/** An active zimmedar of exactly this district, else 409. */
async function zimmedarOf(districtPath: string, userId: string) {
  const target = Types.ObjectId.isValid(userId)
    ? await User.findOne({ _id: userId, role: 'zimmedar', isActive: true })
        .select('ajeerCode name unitPath')
        .lean()
    : null;
  if (!target || districtPathOf(target.unitPath) !== districtPath) {
    throw new AppError(409, 'CONFLICT', 'Only an active zimmedar of the village’s district');
  }
  return target;
}

/**
 * A live village of the district with this normalized name, or one that had it as an earlier
 * spelling (renamed / merged) — the record to use instead of creating a duplicate.
 */
async function sameNameInDistrict(unitPath: string, nameKey: string, exceptId?: Types.ObjectId) {
  return Village.findOne({
    unitPath,
    status: { $in: LIVE },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    $or: [{ nameKey }, { 'formerNames.nameKey': nameKey }],
  })
    .select('name status assignedTo')
    .lean();
}

const villageExists = (v: {
  _id: Types.ObjectId;
  name: string;
  status: string;
  assignedTo?: Types.ObjectId | null;
}) =>
  new AppError(409, 'VILLAGE_EXISTS', 'A village with this name already exists', {
    village: {
      id: String(v._id),
      name: v.name,
      status: v.status,
      assignedTo: v.assignedTo ? String(v.assignedTo) : null,
    },
  });

const isDuplicateKey = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 11000;

/**
 * POST /villages/manage { name, districtCode?, assignTo? } — the District adds a village to its
 * list (approved at once) and may give it to a zimmedar. A name already in the district (or an
 * earlier spelling of one) answers 409 VILLAGE_EXISTS with that village, so the screen offers to
 * assign the existing record instead. Audit VILLAGE_CREATE.
 */
export async function createVillage(
  caller: AuthUser,
  input: { name: string; districtCode?: string; assignTo?: string },
) {
  const district = await districtInScope(caller, input.districtCode);
  const name = input.name.replace(/\s+/g, ' ').trim();
  const nameKey = villageNameKey(name);
  const clash = await sameNameInDistrict(district.path, nameKey);
  if (clash) throw villageExists(clash);
  const assignee = input.assignTo ? await zimmedarOf(district.path, input.assignTo) : null;
  const now = new Date();
  let village;
  try {
    village = await Village.create({
      name,
      nameKey,
      districtCode: district.code,
      unitPath: district.path,
      status: 'approved',
      addedBy: new Types.ObjectId(caller.id),
      approvedBy: new Types.ObjectId(caller.id),
      approvedAt: now,
      ...(assignee ? { assignedTo: assignee._id } : {}),
      source: { kind: 'district', at: now },
    });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const now2 = await sameNameInDistrict(district.path, nameKey);
    if (now2) throw villageExists(now2);
    throw e;
  }
  await audit({
    action: 'VILLAGE_CREATE',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'village',
    targetId: String(village._id),
    unitPath: village.unitPath,
    details: {
      name: village.name,
      assignedTo: assignee ? { id: String(assignee._id), ajeerCode: assignee.ajeerCode } : null,
    },
  });
  return view(village);
}

/**
 * PATCH /villages/:id { name?, tehsil? } — correct the spelling or the tehsil of a live village.
 * The old spelling is kept in formerNames (a later import still finds the village); a name another
 * live village of the district already has answers 409 VILLAGE_EXISTS. Visits keep their snapshot
 * name. Audit VILLAGE_RENAME.
 */
export async function updateVillage(
  caller: AuthUser,
  id: string,
  input: { name?: string; tehsil?: string },
) {
  const village = await villageInScope(caller, id);
  if (village.status === 'merged') throw new AppError(409, 'CONFLICT', 'Village is merged');
  const before = { name: village.name, tehsil: village.tehsil ?? null };
  if (input.name !== undefined) {
    const name = input.name.replace(/\s+/g, ' ').trim();
    const nameKey = villageNameKey(name);
    if (nameKey !== village.nameKey) {
      const clash = await sameNameInDistrict(village.unitPath, nameKey, village._id);
      if (clash) throw villageExists(clash);
      village.formerNames = [
        ...(village.formerNames ?? []),
        { name: village.name, nameKey: village.nameKey, at: new Date(), reason: 'rename' },
      ] as typeof village.formerNames;
      village.nameKey = nameKey;
    }
    village.name = name;
    // A corrected name answers a "similar name" issue (CTO 13 Nov 2026).
    const rest = (village.issues ?? []).filter((i) => i.kind !== 'SIMILAR_NAME');
    village.set('issues', rest.length ? rest : undefined);
  }
  if (input.tehsil !== undefined) {
    const tehsil = input.tehsil.replace(/\s+/g, ' ').trim();
    village.tehsil = tehsil || undefined;
  }
  const after = { name: village.name, tehsil: village.tehsil ?? null };
  if (after.name === before.name && after.tehsil === before.tehsil) return view(village);
  try {
    await village.save();
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const clash = await sameNameInDistrict(village.unitPath, village.nameKey, village._id);
    if (clash) throw villageExists(clash);
    throw e;
  }
  await audit({
    action: 'VILLAGE_RENAME',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'village',
    targetId: String(village._id),
    unitPath: village.unitPath,
    details: { from: before, to: after },
  });
  return view(village);
}

/**
 * GET /villages/duplicates?unit=<district> — groups of live villages whose names look alike
 * (looseVillageKey: spaces, punctuation, diacritics and common letter variants ignored). Only a
 * suggestion: the District decides and merges with POST /villages/:id/merge.
 */
export async function listDuplicates(caller: AuthUser, code?: string) {
  const district = await districtInScope(caller, code);
  const villages = await Village.find({ unitPath: district.path, status: { $in: LIVE } })
    .select('name status districtCode assignedTo')
    .sort({ nameKey: 1 })
    .lean();
  const groups = new Map<string, typeof villages>();
  for (const v of villages) {
    const key = looseVillageKey(v.name);
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.map(view));
}

/**
 * POST /villages/:id/resolve-issue { kind } — the District marks one problem of a pool Gaon as
 * handled ("theek hai": e.g. the similar name is a different Gaon). Audited.
 */
export async function resolveIssue(caller: AuthUser, id: string, kind: VillageIssueKind) {
  const village = await villageInScope(caller, id);
  const before = village.issues ?? [];
  if (!before.some((i) => i.kind === kind)) return view(village);
  const rest = before.filter((i) => i.kind !== kind);
  village.set('issues', rest.length ? rest : undefined);
  await village.save();
  await audit({
    action: 'VILLAGE_ISSUE_RESOLVE',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'village',
    targetId: String(village._id),
    unitPath: village.unitPath,
    details: { name: village.name, kind },
  });
  return view(village);
}
