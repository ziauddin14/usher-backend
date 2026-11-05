// District (and above) village management (Step 4): pending list, approve (with a spelling fix),
// merge into an existing village, and assign / transfer to a zimmedar of the village's district.
// Every action is audited; scope is enforced on the village's unit path (404 outside).
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { assertInScope, scopeFilter } from '../../lib/scope.js';
import { villageNameKey } from '../../lib/text.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';

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
  // The responsible zimmedar of the duplicate keeps the merged village if it had nobody.
  if (!into.assignedTo && village.assignedTo) {
    into.assignedTo = village.assignedTo;
    await into.save();
  }
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
  if (!target || target.unitPath !== village.unitPath) {
    throw new AppError(409, 'CONFLICT', 'Only an active zimmedar of the village’s district');
  }
  const from = village.assignedTo ? String(village.assignedTo) : null;
  if (from === String(target._id)) return view(village);
  village.assignedTo = target._id;
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
