import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { escapeRegex, scopeFilter } from '../../lib/scope.js';
import { villageNameKey } from '../../lib/text.js';
import { Jadwal } from '../../models/jadwal.js';
import { Village } from '../../models/village.js';

export interface VillageItem {
  id: string;
  name: string;
  status: 'approved' | 'pending';
  /** Assigned to the caller (zimmedar: "آپ کے گاؤں"). */
  mine: boolean;
  /** Last date the caller visited it (zimmedar), or null. */
  lastVisitDate: string | null;
}

/**
 * Villages the caller can choose.
 * Zimmedar, no search: only the villages assigned to them (+ their own pending ones).
 * Zimmedar, with search: all approved villages of their district that match, own villages first.
 * Supervisors: approved villages in scope (+ their own pending ones).
 * Inside each group: most recently visited first, then by name.
 */
export async function listVillages(user: AuthUser, q?: string): Promise<VillageItem[]> {
  await connectDb();
  const me = new Types.ObjectId(user.id);
  const isZimmedar = user.role === 'zimmedar';
  const own = [
    { assignedTo: me, status: { $in: ['approved', 'pending'] } },
    { addedBy: me, status: 'pending' },
  ];
  const filter: Record<string, unknown> = {
    ...scopeFilter(user),
    $or: isZimmedar && !q ? own : [...own, { status: 'approved' }],
  };
  if (q) {
    const key = villageNameKey(q);
    filter.$and = [
      {
        $or: [
          { nameKey: { $regex: escapeRegex(key) } },
          { name: { $regex: escapeRegex(q), $options: 'i' } },
        ],
      },
    ];
  }
  const villages = await Village.find(filter)
    .select('name status assignedTo')
    .sort({ nameKey: 1 })
    .limit(q ? 100 : 300)
    .lean();

  const lastVisits = new Map<string, string>();
  if (isZimmedar && villages.length > 0) {
    const rows = await Jadwal.aggregate<{ _id: Types.ObjectId; last: string }>([
      { $match: { userId: me } },
      { $unwind: '$visits' },
      { $group: { _id: '$visits.villageId', last: { $max: '$date' } } },
    ]);
    for (const r of rows) lastVisits.set(String(r._id), r.last);
  }

  return villages
    .map((v) => ({
      id: String(v._id),
      name: v.name,
      status: v.status as 'approved' | 'pending',
      mine: String(v.assignedTo) === user.id,
      lastVisitDate: lastVisits.get(String(v._id)) ?? null,
    }))
    .sort(
      (a, b) =>
        Number(b.mine) - Number(a.mine) ||
        (b.lastVisitDate ?? '').localeCompare(a.lastVisitDate ?? ''),
    );
}

/**
 * A zimmedar adds a village that is not in the list: saved as `pending` (District approves in
 * Step 4) and usable by them right away. Same normalized name in the district → 409 VILLAGE_EXISTS
 * with the existing village.
 */
export async function addVillage(user: AuthUser, name: string): Promise<VillageItem> {
  await connectDb();
  const nameKey = villageNameKey(name);
  const existing = await Village.findOne({
    unitPath: user.unitPath,
    nameKey,
    status: { $in: ['approved', 'pending'] as ('approved' | 'pending')[] },
  }).lean();
  if (existing) {
    throw new AppError(409, 'VILLAGE_EXISTS', 'A village with this name already exists', {
      village: { id: String(existing._id), name: existing.name, status: existing.status },
    });
  }
  const village = await Village.create({
    name: name.replace(/\s+/g, ' ').trim(),
    nameKey,
    districtCode: user.unitCode,
    unitPath: user.unitPath,
    status: 'pending',
    addedBy: new Types.ObjectId(user.id),
    // The adder is responsible for it until the District says otherwise.
    assignedTo: new Types.ObjectId(user.id),
  });
  await audit({
    action: 'VILLAGE_ADD',
    actorId: user.id,
    actorAjeerCode: user.ajeerCode,
    targetType: 'village',
    targetId: String(village._id),
    unitPath: user.unitPath,
    details: { name: village.name },
  });
  return {
    id: String(village._id),
    name: village.name,
    status: 'pending',
    mine: true,
    lastVisitDate: null,
  };
}

/** A village the zimmedar may put in a jadwal: approved in their district, or their own pending one. */
export async function findUsableVillage(user: AuthUser, villageId: string) {
  if (!Types.ObjectId.isValid(villageId)) return null;
  return Village.findOne({
    _id: villageId,
    unitPath: user.unitPath,
    $or: [
      { status: 'approved' },
      { status: 'pending', addedBy: new Types.ObjectId(user.id) },
      { status: 'pending', assignedTo: new Types.ObjectId(user.id) },
    ],
  })
    .select('name')
    .lean();
}
