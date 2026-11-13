// Niyyat per donor (CTO 13 Nov 2026): a niyyat written on the atiyat screen belongs to a donor —
// an old donor of the Gaon, or a new donor of the same visit — with عشر / عطیہ and the month it is
// expected. Saved as a pledge when the day is submitted; closed when the zimmedar meets the donor
// and ticks "وصول ہو گئی". Pledges are never deleted (a niyyat removed from a reopened day is
// marked cancelled).
import { type AnyBulkWriteOperation, type QueryFilter, Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { villageNameKey } from '../../lib/text.js';
import { Donor } from '../../models/donor.js';
import type { JadwalDoc } from '../../models/jadwal.js';
import { Pledge, type PledgeDoc } from '../../models/pledge.js';
import { checkMetDonors } from './service.js';

interface NiyyatEntry {
  type: 'niyyat' | 'wusooli';
  category?: string | null | undefined;
  donorId?: string | Types.ObjectId | null | undefined;
  newDonorName?: string | null | undefined;
}

/** A niyyat per donor (not one with a mad, saved before 13 Nov 2026). */
const perDonor = (e: NiyyatEntry) => e.type === 'niyyat' && !e.category;

/**
 * Atiyat step: each niyyat's donor must be an old donor of the Gaon on that day, or one of the new
 * donors already saved on this visit's donors step.
 */
export async function checkNiyyatDonors(
  villageId: Types.ObjectId,
  date: string,
  entries: NiyyatEntry[],
  newDonorNames: string[],
): Promise<void> {
  const list = entries.filter(perDonor);
  const ids = [...new Set(list.flatMap((e) => (e.donorId ? [String(e.donorId)] : [])))];
  await checkMetDonors(
    villageId,
    date,
    ids.map((donorId) => ({ donorId })),
  );
  const known = new Set(newDonorNames.map(villageNameKey));
  if (list.some((e) => e.newDonorName && !known.has(villageNameKey(e.newDonorName)))) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Not a new donor of this visit', {
      reason: 'NEW_DONOR_UNKNOWN',
    });
  }
}

/** Donors step: the niyyat a met donor received must be open niyyat of that donor. */
export async function checkClosePledges(
  met: { donorId: string; closePledges?: string[] | undefined }[],
): Promise<void> {
  for (const m of met) {
    const ids = m.closePledges ?? [];
    if (ids.length === 0) continue;
    const found = await Pledge.countDocuments({
      _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
      donorId: new Types.ObjectId(m.donorId),
      status: 'open',
    });
    if (found !== new Set(ids).size) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Not an open niyyat of this donor', {
        reason: 'PLEDGE_NOT_OPEN',
      });
    }
  }
}

/**
 * After a jadwal is submitted (after the day's new donors were added): every niyyat per donor is
 * saved as a pledge (one per entry; a re-submit updates it), a niyyat no longer on the day is
 * cancelled, and the niyyat received today are closed.
 */
export async function recordPledges(
  jadwal: Pick<JadwalDoc, 'date' | 'userId' | 'visits'> & { _id: Types.ObjectId },
  unitPathOf: Map<string, string>,
): Promise<void> {
  const writes: AnyBulkWriteOperation<PledgeDoc>[] = [];
  const keep: { visitId: Types.ObjectId; entry: number }[] = [];
  for (const visit of jadwal.visits) {
    const unitPath = unitPathOf.get(String(visit.villageId));
    if (!unitPath) continue;
    const entries = visit.atiyat?.entries ?? [];
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i]!;
      if (!perDonor(e) || !e.niyyatType || !e.dueMonth) continue;
      let donorId = e.donorId ?? null;
      if (!donorId && e.newDonorName) {
        const d = await Donor.findOne({
          villageId: visit.villageId,
          nameKey: villageNameKey(e.newDonorName),
        })
          .select('_id')
          .lean();
        donorId = d?._id ?? null;
      }
      if (!donorId) continue;
      keep.push({ visitId: visit._id, entry: i });
      writes.push({
        updateOne: {
          filter: { jadwalId: jadwal._id, visitId: visit._id, entry: i },
          update: {
            $set: {
              donorId,
              villageId: visit.villageId,
              unitPath,
              userId: jadwal.userId,
              date: jadwal.date,
              niyyatType: e.niyyatType,
              kind: e.kind,
              amount: e.amount,
              dueMonth: e.dueMonth,
              ...(e.detail ? { item: e.detail } : {}),
              ...(typeof e.qty === 'number' ? { qty: e.qty } : {}),
              ...(e.unit ? { unit: e.unit } : {}),
            },
            // A pledge received meanwhile stays received.
            $setOnInsert: { status: 'open' },
          },
          upsert: true,
        },
      });
    }
    for (const m of visit.donors?.met ?? []) {
      const ids = m.closePledges ?? [];
      if (ids.length === 0) continue;
      writes.push({
        updateMany: {
          filter: { _id: { $in: ids }, donorId: m.donorId, status: 'open' },
          update: {
            $set: { status: 'received', received: { date: jadwal.date, jadwalId: jadwal._id } },
          },
        },
      });
    }
  }
  if (writes.length > 0) await Pledge.bulkWrite(writes, { ordered: true });
  // A niyyat removed from a reopened and re-submitted day: cancelled, never deleted.
  const stale: QueryFilter<PledgeDoc> = {
    jadwalId: jadwal._id,
    status: 'open',
    ...(keep.length ? { $nor: keep.map((k) => ({ visitId: k.visitId, entry: k.entry })) } : {}),
  };
  await Pledge.updateMany(stale, { $set: { status: 'cancelled' } });
}

/** Open pledges of a Gaon's donors, by donor id (for the donor list). */
export async function openPledgesOf(villageId: Types.ObjectId) {
  const list = await Pledge.find({ villageId, status: 'open' })
    .select('donorId niyyatType kind amount item qty unit dueMonth date')
    .sort({ dueMonth: 1 })
    .lean();
  const by = new Map<string, typeof list>();
  for (const p of list) by.set(String(p.donorId), [...(by.get(String(p.donorId)) ?? []), p]);
  return by;
}

export interface PledgeSums {
  count: number;
  naqd: number;
  /** Jins by item and unit (quantities added up). */
  jins: { item: string; unit: string; qty: number }[];
}

function sumsOf(
  list: {
    kind: string;
    amount: number;
    item?: string | null;
    unit?: string | null;
    qty?: number | null;
  }[],
): PledgeSums {
  const jins = new Map<string, { item: string; unit: string; qty: number }>();
  let naqd = 0;
  for (const p of list) {
    if (p.kind === 'naqd') naqd += p.amount;
    else {
      const key = `${p.item ?? ''}|${p.unit ?? ''}`;
      const j = jins.get(key) ?? { item: p.item ?? '', unit: p.unit ?? '', qty: 0 };
      j.qty += p.qty ?? 0;
      jins.set(key, j);
    }
  }
  return { count: list.length, naqd, jins: [...jins.values()].sort((a, b) => b.qty - a.qty) };
}

/**
 * Niyyat report of a user or a unit: what is open now (by type and by expected month), and what was
 * written and received in the period.
 */
export async function pledgeReport(
  scope: { userId: Types.ObjectId } | { unitPath: { $regex: string } },
  span: { from: string; to: string },
) {
  const fields = 'niyyatType kind amount item qty unit dueMonth date status received';
  const [open, made, received] = await Promise.all([
    Pledge.find({ ...scope, status: 'open' })
      .select(fields)
      .lean(),
    Pledge.find({
      ...scope,
      status: { $ne: 'cancelled' },
      date: { $gte: span.from, $lte: span.to },
    })
      .select(fields)
      .lean(),
    Pledge.find({
      ...scope,
      status: 'received',
      'received.date': { $gte: span.from, $lte: span.to },
    })
      .select(fields)
      .lean(),
  ]);
  const months = [...new Set(open.map((p) => p.dueMonth))].sort();
  return {
    ...span,
    open: {
      ...sumsOf(open),
      ushr: sumsOf(open.filter((p) => p.niyyatType === 'ushr')),
      atiya: sumsOf(open.filter((p) => p.niyyatType === 'atiya')),
      byMonth: months.map((m) => ({ month: m, ...sumsOf(open.filter((p) => p.dueMonth === m)) })),
    },
    made: sumsOf(made),
    received: sumsOf(received),
  };
}
