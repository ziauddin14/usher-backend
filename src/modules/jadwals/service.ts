import mongoose, { type HydratedDocument, Types } from 'mongoose';
import type { z } from 'zod';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { scopeFilter } from '../../lib/scope.js';
import { getDonorTasks, getSettings } from '../../lib/settings.js';
import { addDays, isDateString, karachiDate, monthOf } from '../../lib/time.js';
import { Jadwal, type JadwalDoc } from '../../models/jadwal.js';
import { computeDayTotals } from '../reports/calc.js';
import { findUsableVillage } from '../villages/service.js';
import { checkTasks } from './tasks.js';
import type {
  atiyatSchema,
  createJadwalSchema,
  donorsSchema,
  ijtimaSchema,
  mashwaraSchema,
  patchJadwalSchema,
  submitSchema,
} from './schemas.js';

type JadwalDocument = HydratedDocument<JadwalDoc>;
type Step = 'donors' | 'atiyat' | 'ijtima' | 'mashwara';

const isDuplicateKey = (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e && e.code === 11000;

/** API shape of a jadwal: ids as strings, no internal fields. */
export function serializeJadwal(doc: JadwalDocument) {
  const j = doc.toObject();
  return {
    id: String(j._id),
    userId: String(j.userId),
    ajeerCode: j.ajeerCode,
    date: j.date,
    month: j.month,
    entryType: j.entryType,
    status: j.status,
    startedAt: j.startedAt,
    submittedAt: j.submittedAt ?? null,
    travel: j.travel ?? null,
    note: j.note ?? null,
    /** The day's other work (CTO 12 Nov 2026); [] when none. */
    otherTasks: j.otherTasks ?? [],
    visits: j.visits.map((v) => ({
      id: String(v._id),
      villageId: String(v.villageId),
      villageName: v.villageName,
      donors: v.donors ?? null,
      atiyat: v.atiyat ?? null,
      ijtima: v.ijtima ?? null,
      mashwara: v.mashwara ?? null,
      savedSteps: v.savedSteps,
    })),
    totals: j.totals ?? null,
    reopened: (j.reopened ?? []).map((r) => ({ by: String(r.by), at: r.at, reason: r.reason })),
    /** Official-duty decision on a full-day mashwara; null = not decided (not field activity). */
    dutyApproval: j.dutyApproval
      ? {
          status: j.dutyApproval.status,
          byAjeerCode: j.dutyApproval.byAjeerCode,
          at: j.dutyApproval.at,
          reason: j.dutyApproval.reason ?? null,
        }
      : null,
  };
}
export type JadwalView = ReturnType<typeof serializeJadwal>;

const userOid = (user: AuthUser) => new Types.ObjectId(user.id);

async function categories() {
  return (await getSettings()).atiyatCategories;
}

/** The caller's own jadwal, still a draft (else 404 / 409 JADWAL_LOCKED). */
async function ownDraft(user: AuthUser, id: string): Promise<JadwalDocument> {
  await connectDb();
  const doc = await Jadwal.findOne({ _id: id, userId: userOid(user) });
  if (!doc) throw new AppError(404, 'NOT_FOUND', 'Jadwal not found');
  if (doc.status !== 'draft') {
    throw new AppError(409, 'JADWAL_LOCKED', 'This jadwal is submitted and cannot be changed');
  }
  return doc;
}

/**
 * Today's jadwal (Karachi date) or null, the last bike meter reading as a hint, and the user's
 * unfinished drafts of earlier dates (back-dated or reopened by the District) so Home can offer
 * them on any device.
 */
export async function todayJadwal(user: AuthUser) {
  await connectDb();
  const today = karachiDate();
  const [doc, lastBike, earlier] = await Promise.all([
    Jadwal.findOne({ userId: userOid(user), date: today }),
    Jadwal.findOne({
      userId: userOid(user),
      status: 'submitted',
      'travel.mode': 'bike',
      'travel.meterEnd': { $ne: null },
    })
      .sort({ date: -1 })
      .select('travel.meterEnd')
      .lean(),
    Jadwal.find({ userId: userOid(user), status: 'draft', date: { $lt: today } })
      .sort({ date: -1 })
      .limit(10)
      .select('date visits._id')
      .lean(),
  ]);
  return {
    today,
    jadwal: doc ? serializeJadwal(doc) : null,
    lastMeterEnd: lastBike?.travel?.meterEnd ?? null,
    otherDrafts: earlier.map((d) => ({
      id: String(d._id),
      date: d.date,
      villages: d.visits.length,
    })),
  };
}

export async function listOwnJadwals(user: AuthUser, from?: string, to?: string) {
  await connectDb();
  const date: Record<string, string> = {};
  if (from) date.$gte = from;
  if (to) date.$lte = to;
  const rows = await Jadwal.find({ userId: userOid(user), ...(from || to ? { date } : {}) })
    .select('date status entryType totals')
    .sort({ date: -1 })
    .limit(400)
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    date: r.date,
    status: r.status,
    entryType: r.entryType,
    totals: r.totals ?? null,
  }));
}

/** Zimmedar: own jadwal only. Supervisors: any jadwal in their scope. Otherwise 404. */
export async function getJadwal(user: AuthUser, id: string): Promise<JadwalView> {
  await connectDb();
  const filter =
    user.role === 'zimmedar'
      ? { _id: id, userId: userOid(user) }
      : { _id: id, ...scopeFilter(user) };
  const doc = await Jadwal.findOne(filter);
  if (!doc) throw new AppError(404, 'NOT_FOUND', 'Jadwal not found');
  return serializeJadwal(doc);
}

/**
 * Start a day. Date: today (Karachi) by default, never in the future, at most
 * `settings.backdateDays` back. One per user per date. Non-amli types are submitted at once.
 */
export async function createJadwal(
  user: AuthUser,
  body: z.infer<typeof createJadwalSchema>,
): Promise<JadwalView> {
  await connectDb();
  const settings = await getSettings();
  const today = karachiDate();
  const date = body.date ?? today;
  const earliest = addDays(today, -settings.backdateDays);
  if (!isDateString(date) || date > today || date < earliest) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Date is outside the allowed window', {
      reason: 'DATE_OUT_OF_RANGE',
      earliest,
      latest: today,
    });
  }

  const existing = await Jadwal.findOne({ userId: userOid(user), date })
    .select('_id')
    .lean();
  if (existing) {
    throw new AppError(409, 'CONFLICT', 'A jadwal for this date already exists', {
      jadwalId: String(existing._id),
    });
  }

  const now = new Date();
  const isAmli = body.entryType === 'amli';
  try {
    const doc = await Jadwal.create({
      userId: userOid(user),
      ajeerCode: user.ajeerCode,
      unitPath: user.unitPath,
      date,
      month: monthOf(date),
      entryType: body.entryType,
      status: isAmli ? 'draft' : 'submitted',
      startedAt: now,
      ...(isAmli ? { travel: body.travel } : { submittedAt: now }),
      ...(body.note ? { note: body.note } : {}),
      visits: [],
      ...(isAmli ? {} : { totals: computeDayTotals({ visits: [] }, settings.atiyatCategories) }),
    });
    if (!isAmli) await auditSubmit(user, doc);
    return serializeJadwal(doc);
  } catch (e) {
    if (isDuplicateKey(e))
      throw new AppError(409, 'CONFLICT', 'A jadwal for this date already exists');
    throw e;
  }
}

export async function patchJadwal(
  user: AuthUser,
  id: string,
  body: z.infer<typeof patchJadwalSchema>,
): Promise<JadwalView> {
  const doc = await ownDraft(user, id);
  if (body.travel) doc.set('travel', body.travel);
  if (body.note !== undefined) doc.note = body.note;
  await doc.save();
  return serializeJadwal(doc);
}

export async function addVisit(user: AuthUser, id: string, villageId: string) {
  const doc = await ownDraft(user, id);
  if (doc.entryType !== 'amli') {
    throw new AppError(400, 'VALIDATION_FAILED', 'Villages are only for an amli jadwal');
  }
  const village = await findUsableVillage(user, villageId);
  if (!village) throw new AppError(404, 'NOT_FOUND', 'Village not found');
  if (doc.visits.some((v) => String(v.villageId) === villageId)) {
    throw new AppError(409, 'CONFLICT', 'This village is already in today’s jadwal', {
      reason: 'VILLAGE_ALREADY_ADDED',
    });
  }
  doc.visits.push({ villageId: village._id, villageName: village.name, savedSteps: [] });
  await doc.save();
  return serializeJadwal(doc);
}

export async function deleteVisit(user: AuthUser, id: string, visitId: string) {
  const doc = await ownDraft(user, id);
  const visit = doc.visits.id(visitId);
  if (!visit) throw new AppError(404, 'NOT_FOUND', 'Visit not found');
  if (visit.savedSteps.length > 0) {
    throw new AppError(409, 'CONFLICT', 'A visit with saved work cannot be removed', {
      reason: 'VISIT_HAS_DATA',
    });
  }
  visit.deleteOne();
  await doc.save();
  return serializeJadwal(doc);
}

type StepData = {
  donors: z.infer<typeof donorsSchema>;
  atiyat: z.infer<typeof atiyatSchema>;
  ijtima: z.infer<typeof ijtimaSchema>;
  mashwara: z.infer<typeof mashwaraSchema>;
};

/** Save one of the 4 village tasks; returns the visit and its savedSteps. */
export async function saveStep<S extends Step>(
  user: AuthUser,
  id: string,
  visitId: string,
  step: S,
  data: StepData[S],
) {
  const doc = await ownDraft(user, id);
  const visit = doc.visits.id(visitId);
  if (!visit) throw new AppError(404, 'NOT_FOUND', 'Visit not found');

  if (step === 'donors') {
    // What was done with each donor (CTO 12 Nov 2026), checked against settings.donorTasks.
    const donors = data as StepData['donors'];
    const defs = await getDonorTasks();
    if (donors.oldTasks) donors.oldTasks = checkTasks(donors.oldTasks, defs);
    for (const d of donors.newDonors) if (d.tasks) d.tasks = checkTasks(d.tasks, defs);
  }

  if (step === 'atiyat') {
    const atiyat = data as StepData['atiyat'];
    const known = new Set((await categories()).map((c) => c.id));
    const unknown = atiyat.entries.find((e) => !known.has(e.category));
    if (unknown) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        `Unknown atiyat category "${unknown.category}"`,
        {
          reason: 'UNKNOWN_CATEGORY',
        },
      );
    }
    // GSB (gharelu sadqa box) is money collected from boxes — wusooli only, never a pledge.
    if (atiyat.entries.some((e) => e.category === 'gsb' && e.type !== 'wusooli')) {
      throw new AppError(400, 'VALIDATION_FAILED', 'GSB can only be wusooli', {
        reason: 'GSB_ONLY_WUSOOLI',
      });
    }
  }

  const value =
    step === 'ijtima' && !(data as StepData['ijtima']).held
      ? { held: false }
      : step === 'mashwara' && !(data as StepData['mashwara']).held
        ? { held: false }
        : data;
  visit.set(step, value);
  if (!visit.savedSteps.includes(step)) visit.savedSteps.push(step);
  await doc.save();

  const view = serializeJadwal(doc).visits.find((v) => v.id === visitId)!;
  return { visit: view, savedSteps: view.savedSteps };
}

async function auditSubmit(user: AuthUser, doc: JadwalDocument) {
  await audit({
    action: 'JADWAL_SUBMIT',
    actorId: user.id,
    actorAjeerCode: user.ajeerCode,
    targetType: 'jadwal',
    targetId: String(doc._id),
    unitPath: doc.unitPath,
    // A day submitted after its own date is marked back-dated (CTO 5 Nov 2026).
    details: { date: doc.date, entryType: doc.entryType, backdated: doc.date < karachiDate() },
  });
}

/** End the day: checks, computes totals and locks the jadwal. */
export async function submitJadwal(
  user: AuthUser,
  id: string,
  body: z.infer<typeof submitSchema>,
): Promise<JadwalView> {
  const doc = await ownDraft(user, id);
  if (body.otherTasks !== undefined) {
    const other = checkTasks(body.otherTasks, await getDonorTasks(), true);
    doc.set('otherTasks', other.length > 0 ? other : undefined);
  }
  // A day may have no Gaon when it had other work instead (CTO 12 Nov 2026).
  if (doc.entryType === 'amli' && doc.visits.length === 0 && !doc.otherTasks?.length) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Add a village or the other work of the day', {
      reason: 'NO_VISITS',
    });
  }
  if (doc.travel?.mode === 'bike') {
    const start = doc.travel.meterStart ?? 0;
    if (body.meterEnd === undefined) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Meter end reading is required', {
        reason: 'METER_END_REQUIRED',
      });
    }
    if (body.meterEnd < start) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Meter end must be ≥ meter start', {
        reason: 'METER_END_BEFORE_START',
      });
    }
    doc.set('travel.meterEnd', body.meterEnd);
    doc.set('travel.km', body.meterEnd - start);
  }
  if (doc.travel?.mode === 'bus') {
    // The fare is entered when the day ends (CTO 11 Nov 2026); a fare sent at the start (older
    // client) or kept from before a reopen is used when none is sent now.
    const fare = body.fare ?? doc.travel.fare;
    if (fare === undefined || fare === null) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Bus fare is required', {
        reason: 'FARE_REQUIRED',
      });
    }
    doc.set('travel.fare', fare);
  }
  if (body.note !== undefined) doc.note = body.note;

  doc.set('totals', computeDayTotals(doc.toObject(), await categories()));
  doc.status = 'submitted';
  doc.submittedAt = new Date();
  // One conditional write: it lands only while the jadwal is still a draft (a second submit of the
  // same draft gets 409 instead of overwriting the first), and the same write removes any official-
  // duty decision, so a (re-)submitted mashwara is always undecided. A decision made after this
  // write belongs to this submission and is never touched here.
  doc.set('dutyApproval', undefined);
  doc.markModified('dutyApproval');
  doc.$where = { status: 'draft' };
  try {
    await doc.save();
  } catch (error) {
    if (error instanceof mongoose.Error.DocumentNotFoundError) {
      throw new AppError(409, 'JADWAL_LOCKED', 'This jadwal was submitted meanwhile');
    }
    throw error;
  }
  await auditSubmit(user, doc);
  return serializeJadwal(doc);
}

/** District or above, in scope: back to draft with a reason (audited). */
export async function reopenJadwal(
  user: AuthUser,
  id: string,
  reason: string,
): Promise<JadwalView> {
  await connectDb();
  const found = await Jadwal.findOne({ _id: id, ...scopeFilter(user) })
    .select('status')
    .lean();
  if (!found) throw new AppError(404, 'NOT_FOUND', 'Jadwal not found');
  if (found.status !== 'submitted')
    throw new AppError(409, 'CONFLICT', 'Only a submitted jadwal can be reopened');
  // One atomic write: back to draft and the official-duty decision of a full-day mashwara always
  // removed — even one written a moment ago — so a re-submitted mashwara must be decided again.
  // The returned document is the one before the write: it tells which decision was cleared (the
  // decisions themselves stay in the audit log, MASHWARA_DUTY_*).
  const before = await Jadwal.findOneAndUpdate(
    { _id: found._id, status: 'submitted' },
    {
      $set: { status: 'draft' },
      $push: { reopened: { by: userOid(user), at: new Date(), reason } },
      $unset: { dutyApproval: 1 },
    },
    { returnDocument: 'before' },
  ).lean();
  if (!before) throw new AppError(409, 'CONFLICT', 'Only a submitted jadwal can be reopened');
  const cleared = before.dutyApproval ?? null;
  const doc = await Jadwal.findById(found._id);
  if (!doc) throw new AppError(404, 'NOT_FOUND', 'Jadwal not found');
  await audit({
    action: 'JADWAL_REOPEN',
    actorId: user.id,
    actorAjeerCode: user.ajeerCode,
    targetType: 'jadwal',
    targetId: String(doc._id),
    unitPath: doc.unitPath,
    details: {
      date: doc.date,
      ajeerCode: doc.ajeerCode,
      reason,
      ...(cleared
        ? {
            clearedDutyApproval: cleared.status,
            // The full decision this reopen removed (the audit log keeps every decision).
            clearedDutyDecision: {
              status: cleared.status,
              byAjeerCode: cleared.byAjeerCode,
              at: cleared.at,
              reason: cleared.reason ?? null,
            },
          }
        : {}),
    },
  });
  return serializeJadwal(doc);
}
