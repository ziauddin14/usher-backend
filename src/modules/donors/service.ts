// Donors of a Gaon (CTO 12 Nov 2026): the zimmedar sees his Gaon's old donors with the last
// meeting and its tasks, ticks the ones he met (with what he did), and on submitting the day those
// meetings are recorded and the day's new donors join the Gaon's list from the next day on.
import { type AnyBulkWriteOperation, type QueryFilter, Types } from 'mongoose';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { villageNameKey } from '../../lib/text.js';
import { karachiDate } from '../../lib/time.js';
import { Donor, type DonorDoc } from '../../models/donor.js';
import type { JadwalDoc } from '../../models/jadwal.js';
import { Village } from '../../models/village.js';
import { findUsableVillage } from '../villages/service.js';

/**
 * Old donors of a Gaon on `date`: every imported donor, and a donor a zimmedar added on an earlier
 * day (a new donor counts from the next day on).
 */
const oldOn = (villageId: Types.ObjectId, date: string): QueryFilter<DonorDoc> => ({
  villageId,
  isActive: true,
  $or: [{ 'source.kind': 'import' }, { addedOn: { $lt: date } }],
});

/**
 * GET /villages/:id/donors?date= — the Gaon (with its local zimmedar) and its old donors for the
 * zimmedar the Gaon is assigned to. `isNew`: added by a zimmedar and not met since.
 */
export async function villageDonors(user: AuthUser, villageId: string, date?: string) {
  await connectDb();
  const usable = await findUsableVillage(user, villageId);
  if (!usable) throw new AppError(404, 'NOT_FOUND', 'Village not found');
  const village = await Village.findById(usable._id).select('name localZimmedar').lean();
  const donors = await Donor.find(oldOn(usable._id, date ?? karachiDate()))
    .select('name mobile acres source.kind meetings lastMet')
    .sort({ nameKey: 1 })
    .lean();
  return {
    village: {
      id: String(usable._id),
      name: village!.name,
      localZimmedar:
        village!.localZimmedar?.name || village!.localZimmedar?.mobile
          ? {
              name: village!.localZimmedar.name ?? null,
              mobile: village!.localZimmedar.mobile ?? null,
            }
          : null,
    },
    donors: donors.map((d) => ({
      id: String(d._id),
      name: d.name,
      mobile: d.mobile ?? null,
      acres: d.acres ?? null,
      isNew: d.source.kind === 'zimmedar' && d.meetings === 0,
      lastMet: d.lastMet
        ? {
            date: d.lastMet.date,
            tasks: (d.lastMet.tasks ?? []).map((t) => ({
              id: t.id,
              ...(t.count !== null && t.count !== undefined ? { count: t.count } : {}),
              ...(t.parts?.length ? { parts: t.parts } : {}),
            })),
          }
        : null,
    })),
  };
}

/** The ticked old donors of a visit must be old donors of that Gaon on the jadwal's date. */
export async function checkMetDonors(
  villageId: Types.ObjectId,
  date: string,
  met: { donorId: string }[],
): Promise<void> {
  if (met.length === 0) return;
  const ids = met.map((m) => m.donorId);
  if (new Set(ids).size !== ids.length) {
    throw new AppError(400, 'VALIDATION_FAILED', 'A donor is listed twice', {
      reason: 'DONOR_TWICE',
    });
  }
  const found = await Donor.countDocuments({
    ...oldOn(villageId, date),
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
  });
  if (found !== ids.length) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Not an old donor of this Gaon', {
      reason: 'DONOR_NOT_IN_VILLAGE',
    });
  }
}

/**
 * After a jadwal is submitted: each ticked old donor gets this meeting (the latest one is kept),
 * and each new donor of the day joins its Gaon's list (from the next day; marked new until met).
 */
export async function recordDonorMeetings(
  jadwal: Pick<JadwalDoc, 'date' | 'userId' | 'visits'> & { _id: Types.ObjectId },
): Promise<void> {
  const writes: AnyBulkWriteOperation<DonorDoc>[] = [];
  const villages = await Village.find({ _id: { $in: jadwal.visits.map((v) => v.villageId) } })
    .select('_id unitPath')
    .lean();
  const pathOf = new Map(villages.map((v) => [String(v._id), v.unitPath]));
  const now = new Date();
  for (const visit of jadwal.visits) {
    const d = visit.donors;
    if (!d) continue;
    for (const m of d.met ?? []) {
      const lastMet = {
        date: jadwal.date,
        jadwalId: jadwal._id,
        ...(m.tasks?.length ? { tasks: m.tasks } : {}),
      };
      // A later meeting is never replaced by an earlier (back-dated) one.
      writes.push({
        updateOne: {
          filter: {
            _id: m.donorId,
            $or: [{ lastMet: { $exists: false } }, { 'lastMet.date': { $lte: jadwal.date } }],
          },
          update: { $set: { lastMet }, $inc: { meetings: 1 } },
        },
      });
      writes.push({
        updateOne: {
          filter: { _id: m.donorId, 'lastMet.date': { $gt: jadwal.date } },
          update: { $inc: { meetings: 1 } },
        },
      });
    }
    const unitPath = pathOf.get(String(visit.villageId));
    if (!unitPath) continue;
    for (const n of d.newDonors ?? []) {
      const nameKey = villageNameKey(n.name);
      writes.push({
        updateOne: {
          filter: n.mobile
            ? { villageId: visit.villageId, mobile: n.mobile }
            : { villageId: visit.villageId, nameKey, mobile: { $exists: false } },
          update: {
            $setOnInsert: {
              villageId: visit.villageId,
              unitPath,
              name: n.name,
              nameKey,
              ...(n.mobile ? { mobile: n.mobile } : {}),
              ...(n.acres !== undefined && n.acres !== null ? { acres: n.acres } : {}),
              addedOn: jadwal.date,
              source: {
                kind: 'zimmedar',
                jadwalId: jadwal._id,
                byUserId: jadwal.userId,
                at: now,
              },
              meetings: 0,
              isActive: true,
            },
          },
          upsert: true,
        },
      });
    }
  }
  if (writes.length > 0) await Donor.bulkWrite(writes, { ordered: false });
}
