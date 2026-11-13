// No Tehsil level (CTO 13 Nov 2026, user management): a Tehsil/Town Zimmedar does the same field
// work as an Ushar Zimmedar and both report to the District. One-time migration of a database
// made under the Tehsil level of 9 Nov 2026:
//  - every Tehsil account becomes a zimmedar of its District (designation "tehsil_town"),
//  - every zimmedar under a Tehsil moves to the District itself,
//  - Tehsil units are deactivated (never deleted; history keeps its paths).
// Passwords, sessions, mobiles and Gaon assignments are untouched. Idempotent.
import { audit } from '../../lib/audit.js';
import { connectDb } from '../../lib/db.js';
import { districtCodeOf, districtPathOf } from '../../lib/scope.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';

export interface NoTehsilResult {
  tehsilAccounts: number;
  zimmedaranMoved: number;
  tehsilUnits: number;
}

export async function migrateNoTehsil({
  dryRun,
  operator,
}: {
  dryRun: boolean;
  operator: string;
}): Promise<NoTehsilResult> {
  await connectDb();
  const tehsilUsers = await User.find({ role: 'tehsil' }).select('_id unitPath').lean();
  const deepZimmedaran = (
    await User.find({ role: 'zimmedar', unitPath: { $regex: '^[^/]+/[^/]+/[^/]+/[^/]+/' } })
      .select('_id unitPath')
      .lean()
  ).filter((u) => !u.unitPath.startsWith('TEST/'));
  const tehsilUnits = await Unit.countDocuments({ level: 'tehsil', isActive: true });
  const result = {
    tehsilAccounts: tehsilUsers.length,
    zimmedaranMoved: deepZimmedaran.length,
    tehsilUnits,
  };
  if (dryRun) return result;

  const toDistrict = (path: string) => {
    const p = districtPathOf(path);
    const c = districtCodeOf(path);
    if (!p || !c) throw new Error(`No District above ${path}`);
    return { unitPath: p, unitCode: c };
  };
  if (tehsilUsers.length) {
    await User.bulkWrite(
      tehsilUsers.map((u) => ({
        updateOne: {
          filter: { _id: u._id, role: 'tehsil' },
          update: {
            $set: { role: 'zimmedar', zimmedari: 'tehsil_town', ...toDistrict(u.unitPath) },
          },
        },
      })),
    );
  }
  if (deepZimmedaran.length) {
    await User.bulkWrite(
      deepZimmedaran.map((u) => ({
        updateOne: { filter: { _id: u._id }, update: { $set: toDistrict(u.unitPath) } },
      })),
    );
  }
  await Unit.updateMany({ level: 'tehsil', isActive: true }, { $set: { isActive: false } });
  await audit({
    action: 'MIGRATE_NO_TEHSIL',
    actorAjeerCode: operator,
    targetType: 'migration',
    details: { ...result },
  });
  return result;
}
