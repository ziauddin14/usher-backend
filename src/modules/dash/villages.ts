import type { Types } from 'mongoose';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { assertInScope, escapeRegex, scopeFilter } from '../../lib/scope.js';
import { getCrops } from '../../lib/settings.js';
import { karachiDate } from '../../lib/time.js';
import { Donor } from '../../models/donor.js';
import { Jadwal } from '../../models/jadwal.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { infoOf } from '../villages/info.js';
import type { VillageBrowseQuery } from './schemas.js';

export const VILLAGE_PAGE_SIZE = 50;
/** The Excel of the Gaon list holds every filtered Gaon, up to this many. */
export const VILLAGE_EXPORT_MAX = 5000;

const prefix = (path: string) => ({ $regex: `^${escapeRegex(path)}(/|$)` });

/** GET /dash/units-tree — the Suba, Division and District units in scope, for the filters. */
export async function unitsTree(caller: AuthUser) {
  await connectDb();
  const units = await Unit.find({
    level: { $in: ['suba', 'division', 'district'] },
    ...scopeFilter(caller, 'path'),
  })
    .select('code name nameUr level parentCode')
    .sort({ name: 1 })
    .lean();
  return units.map((u) => ({
    code: u.code,
    name: u.name,
    nameUr: u.nameUr ?? null,
    level: u.level,
    parentCode: u.parentCode ?? null,
  }));
}

/**
 * GET /dash/villages — every live Gaon in the caller's scope (CTO 17 Nov 2026: the Gaon list opens
 * on all Gaon, not on one District), with filters and counts. Counts follow the unit and name
 * filters only, so each filter chip shows how many it would give.
 */
export async function browseVillages(
  caller: AuthUser,
  q: VillageBrowseQuery,
  opts: { all?: boolean } = {},
) {
  await connectDb();
  const and: Record<string, unknown>[] = [
    scopeFilter(caller),
    { status: q.status ?? { $in: ['approved', 'pending'] } },
  ];
  // The narrowest unit chosen decides (District inside Division inside Suba).
  const unitCode = q.district ?? q.division ?? q.suba;
  if (unitCode) {
    const unit = await Unit.findOne({ code: unitCode }).select('path').lean();
    assertInScope(caller, unit ? { unitPath: unit.path } : null);
    and.push({ unitPath: prefix(unit!.path) });
  }
  if (q.q) and.push({ name: { $regex: escapeRegex(q.q), $options: 'i' } });
  const base = { $and: and };

  const month = karachiDate().slice(0, 7);
  const [active, visitedRows, units] = await Promise.all([
    User.find({ role: 'zimmedar', isActive: true }).select('_id').lean(),
    Jadwal.aggregate<{ _id: Types.ObjectId | null }>([
      { $match: { ...scopeFilter(caller), month, status: 'submitted' } },
      { $unwind: '$visits' },
      { $group: { _id: '$visits.villageId' } },
    ]),
    Unit.find({ level: { $in: ['suba', 'division', 'district'] } })
      .select('code name nameUr')
      .lean(),
  ]);
  const activeIds = active.map((u) => u._id);
  const visitedIds = visitedRows.map((v) => v._id).filter((id): id is Types.ObjectId => !!id);

  const filters: Record<string, unknown>[] = [];
  if (q.assigned === 'yes') filters.push({ assignedTo: { $in: activeIds } });
  if (q.assigned === 'no') filters.push({ assignedTo: null });
  if (q.assigned === 'orphaned') filters.push({ assignedTo: { $ne: null, $nin: activeIds } });
  if (q.issue === 'yes') filters.push({ 'issues.0': { $exists: true } });
  else if (q.issue === 'no') filters.push({ 'issues.0': { $exists: false } });
  else if (q.issue) filters.push({ 'issues.kind': q.issue });
  if (q.visited === 'yes') filters.push({ _id: { $in: visitedIds } });
  if (q.visited === 'no') filters.push({ _id: { $nin: visitedIds } });
  // Missing information (CTO 17 Nov 2026).
  if (q.info === 'noLocation') filters.push({ location: null });
  if (q.info === 'noLocalZimmedar') {
    filters.push({ 'localZimmedar.name': { $in: [null, ''] } });
    filters.push({ 'localZimmedar.mobile': { $in: [null, ''] } });
  }
  if (q.info === 'noCrops') filters.push({ 'crops.0': { $exists: false } });
  const filter = filters.length ? { $and: [...and, ...filters] } : base;

  const [countRows, total, rows] = await Promise.all([
    Village.aggregate<Record<string, number>>([
      { $match: base },
      {
        $group: {
          _id: null,
          all: { $sum: 1 },
          assigned: { $sum: { $cond: [{ $in: ['$assignedTo', activeIds] }, 1, 0] } },
          pool: { $sum: { $cond: [{ $ifNull: ['$assignedTo', false] }, 0, 1] } },
          issues: {
            $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$issues', []] } }, 0] }, 1, 0] },
          },
          visited: { $sum: { $cond: [{ $in: ['$_id', visitedIds] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          located: { $sum: { $cond: [{ $ifNull: ['$location', false] }, 1, 0] } },
          withLocal: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $gt: [{ $strLenCP: { $ifNull: ['$localZimmedar.name', ''] } }, 0] },
                    { $gt: [{ $strLenCP: { $ifNull: ['$localZimmedar.mobile', ''] } }, 0] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          withCrops: {
            $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$crops', []] } }, 0] }, 1, 0] },
          },
        },
      },
    ]),
    Village.countDocuments(filter),
    Village.find(filter)
      .select(
        'name status unitPath districtCode assignedTo issues localZimmedar crops cropsOther location',
      )
      .sort({ unitPath: 1, nameKey: 1 })
      .skip(opts.all ? 0 : (q.page - 1) * VILLAGE_PAGE_SIZE)
      .limit(opts.all ? VILLAGE_EXPORT_MAX : VILLAGE_PAGE_SIZE)
      .lean(),
  ]);
  const c = countRows[0] ?? {};
  const n = (k: string) => c[k] ?? 0;
  const counts = {
    all: n('all'),
    assigned: n('assigned'),
    pool: n('pool'),
    orphaned: n('all') - n('assigned') - n('pool'),
    issues: n('issues'),
    noIssues: n('all') - n('issues'),
    visited: n('visited'),
    notVisited: n('all') - n('visited'),
    pending: n('pending'),
    noLocation: n('all') - n('located'),
    noLocalZimmedar: n('all') - n('withLocal'),
    noCrops: n('all') - n('withCrops'),
  };

  const [people, donorCounts, cropDefs] = await Promise.all([
    User.find({ _id: { $in: rows.map((r) => r.assignedTo).filter(Boolean) } })
      .select('ajeerCode name nameUr')
      .lean(),
    // The Gaon's people: its donors (CTO 17 Nov 2026).
    Donor.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { villageId: { $in: rows.map((r) => r._id) }, isActive: true } },
      { $group: { _id: '$villageId', n: { $sum: 1 } } },
    ]),
    getCrops(),
  ]);
  const donorsOf = new Map(donorCounts.map((d) => [String(d._id), d.n]));
  const cropOf = new Map(cropDefs.map((c) => [c.id, c]));
  const personOf = new Map(people.map((p) => [String(p._id), p]));
  const unitOf = new Map(units.map((u) => [u.code, u]));
  const named = (code: string | undefined) => {
    const u = code ? unitOf.get(code) : undefined;
    return u ? { code: u.code, name: u.name, nameUr: u.nameUr ?? null } : null;
  };
  const activeSet = new Set(activeIds.map(String));
  const seen = new Set(visitedIds.map(String));

  return {
    month,
    page: q.page,
    pageSize: VILLAGE_PAGE_SIZE,
    total,
    counts,
    villages: rows.map((v) => {
      const [, suba, division, district] = v.unitPath.split('/');
      const p = v.assignedTo ? personOf.get(String(v.assignedTo)) : undefined;
      return {
        id: String(v._id),
        name: v.name,
        status: v.status,
        suba: named(suba),
        division: named(division),
        district: named(district ?? v.districtCode),
        zimmedar: p
          ? { id: String(p._id), ajeerCode: p.ajeerCode, name: p.name, nameUr: p.nameUr ?? null }
          : null,
        // Assigned to someone who is no longer an active zimmedar.
        orphaned: !!v.assignedTo && !activeSet.has(String(v.assignedTo)),
        visited: seen.has(String(v._id)),
        issues: (v.issues ?? []).map((i) => ({
          kind: i.kind,
          detail: i.detail ?? null,
          suggestionName: i.suggestionName ?? null,
        })),
        // Location, crops and local zimmedar (CTO 17 Nov 2026), with the crops' labels.
        ...(() => {
          const info = infoOf(v);
          return {
            ...info,
            crops: info.crops.map((id) => ({
              id,
              labelUr: cropOf.get(id)?.labelUr ?? id,
              labelRoman: cropOf.get(id)?.labelRoman ?? id,
            })),
          };
        })(),
        donors: donorsOf.get(String(v._id)) ?? 0,
      };
    }),
  };
}
