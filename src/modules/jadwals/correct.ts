// POST /jadwals/:id/correct — the Admin corrects a submitted jadwal directly (CTO 14 Nov 2026).
// What can be corrected: the travel numbers, a visit's Gaon (only while that visit has no donor
// records — else reopen it), a visit removed, an atiyat entry's amount / quantity or the entry
// removed, the GSB boxes and amount, ijtima and mashwara participants. Donor meetings are corrected
// by reopening the day (the zimmedar fixes them). A reason is required; the day stays submitted,
// totals and the day's niyyat records are recalculated, and the audit log keeps the changes with
// the totals before and after (JADWAL_CORRECT).
import { Types } from 'mongoose';
import type { z } from 'zod';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { districtPathOf, scopeFilter } from '../../lib/scope.js';
import { getSettings } from '../../lib/settings.js';
import { Jadwal } from '../../models/jadwal.js';
import { Village } from '../../models/village.js';
import { recordPledges } from '../donors/pledges.js';
import { computeDayTotals } from '../reports/calc.js';
import type { correctSchema } from './schemas.js';
import { serializeJadwal } from './service.js';

type Body = z.infer<typeof correctSchema>;

const conflict = (message: string, reason: string) =>
  new AppError(409, 'CONFLICT', message, { reason });

export async function correctJadwal(caller: AuthUser, id: string, body: Body) {
  await connectDb();
  const doc = await Jadwal.findOne({ _id: id, ...scopeFilter(caller) });
  if (!doc) throw new AppError(404, 'NOT_FOUND', 'Jadwal not found');
  if (doc.status !== 'submitted') {
    throw conflict('Only a submitted jadwal is corrected', 'NOT_SUBMITTED');
  }
  const categories = (await getSettings()).atiyatCategories;
  const before = computeDayTotals(doc.toObject(), categories);
  const changes: string[] = [];

  if (body.travel) {
    const t = doc.travel;
    if (!t) throw conflict('This day has no travel', 'NO_TRAVEL');
    if (t.mode === 'bike') {
      const start = body.travel.meterStart ?? t.meterStart ?? 0;
      const end = body.travel.meterEnd ?? t.meterEnd ?? start;
      if (end < start) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Meter end must be ≥ meter start', {
          reason: 'METER_END_BEFORE_START',
        });
      }
      doc.set('travel.meterStart', start);
      doc.set('travel.meterEnd', end);
      doc.set('travel.km', end - start);
      changes.push(`travel: meter ${start}–${end}`);
    } else if (body.travel.fare !== undefined) {
      doc.set('travel.fare', body.travel.fare);
      changes.push(`travel: fare ${body.travel.fare}`);
    }
  }

  const removeVisits = new Set<string>();
  for (const v of body.visits ?? []) {
    const visit = doc.visits.find((x) => String(x._id) === v.visitId);
    if (!visit) throw new AppError(404, 'NOT_FOUND', 'Visit not found', { visitId: v.visitId });
    const label = visit.villageName;
    if (v.remove) {
      removeVisits.add(v.visitId);
      changes.push(`visit removed: ${label}`);
      continue;
    }
    if (v.villageId && v.villageId !== String(visit.villageId)) {
      const hasDonors =
        (visit.donors?.met?.length ?? 0) > 0 ||
        (visit.donors?.newDonors?.length ?? 0) > 0 ||
        (visit.atiyat?.entries ?? []).some((e) => e.donorId || e.newDonorName);
      if (hasDonors) {
        throw conflict('This visit has donor records — reopen the day instead', 'VISIT_HAS_DONORS');
      }
      if (doc.visits.some((x) => String(x.villageId) === v.villageId)) {
        throw conflict('This Gaon is already on the day', 'VILLAGE_ALREADY_VISITED');
      }
      const district = districtPathOf(doc.unitPath);
      const village = Types.ObjectId.isValid(v.villageId)
        ? await Village.findOne({
            _id: v.villageId,
            status: { $in: ['approved', 'pending'] },
            ...(district ? { unitPath: district } : {}),
          })
            .select('name')
            .lean()
        : null;
      if (!village) {
        throw new AppError(404, 'NOT_FOUND', 'Gaon not found in this District', {
          field: 'villageId',
        });
      }
      visit.set('villageId', village._id);
      visit.set('villageName', village.name);
      changes.push(`visit Gaon: ${label} → ${village.name}`);
    }
    if (v.entries?.length) {
      const entries = visit.atiyat?.entries ?? [];
      const drop = new Set<number>();
      for (const e of v.entries) {
        const entry = entries[e.index];
        if (!entry) {
          throw new AppError(404, 'NOT_FOUND', 'Atiyat entry not found', { index: e.index });
        }
        if (e.remove) {
          drop.add(e.index);
          changes.push(`${label}: ${entry.type} ${entry.kind} ${entry.amount} removed`);
          continue;
        }
        if (e.amount !== undefined && e.amount !== entry.amount) {
          changes.push(`${label}: ${entry.type} ${entry.kind} ${entry.amount} → ${e.amount}`);
          entry.amount = e.amount;
        }
        if (e.qty !== undefined && e.qty !== entry.qty) {
          changes.push(`${label}: qty ${entry.qty ?? '-'} → ${e.qty}`);
          entry.qty = e.qty;
        }
      }
      if (drop.size) {
        visit.set(
          'atiyat.entries',
          entries.filter((_, i) => !drop.has(i)),
        );
      }
    }
    if (v.gsb) {
      if (!visit.atiyat) throw conflict('No atiyat on this visit', 'NO_ATIYAT');
      visit.set('atiyat.gsb', { ...v.gsb });
      changes.push(`${label}: GSB ${v.gsb.boxesOpened} boxes, ${v.gsb.amount}`);
    }
    if (v.ijtimaParticipants !== undefined) {
      if (!visit.ijtima?.held) throw conflict('No ijtima on this visit', 'NO_IJTIMA');
      visit.set('ijtima.participants', v.ijtimaParticipants);
      changes.push(`${label}: ijtima participants ${v.ijtimaParticipants}`);
    }
    if (v.mashwaraParticipants !== undefined) {
      if (!visit.mashwara?.held) throw conflict('No mashwara on this visit', 'NO_MASHWARA');
      visit.set('mashwara.participants', v.mashwaraParticipants);
      changes.push(`${label}: mashwara participants ${v.mashwaraParticipants}`);
    }
  }
  if (removeVisits.size) {
    const left = doc.visits.filter((x) => !removeVisits.has(String(x._id)));
    if (left.length === 0 && !doc.otherTasks?.length && doc.entryType === 'amli') {
      throw conflict('A day keeps at least one Gaon or other work', 'NO_VISITS');
    }
    doc.set('visits', left);
  }
  if (changes.length === 0) throw new AppError(400, 'VALIDATION_FAILED', 'Nothing to correct');

  const after = computeDayTotals(doc.toObject(), categories);
  doc.set('totals', after);
  doc.corrections.push({
    by: new Types.ObjectId(caller.id),
    byAjeerCode: caller.ajeerCode,
    at: new Date(),
    reason: body.reason,
  });
  await doc.save();
  // The day's niyyat records follow the corrected entries (removed → cancelled, never deleted).
  if (doc.entryType === 'amli') {
    const villages = await Village.find({ _id: { $in: doc.visits.map((v) => v.villageId) } })
      .select('_id unitPath')
      .lean();
    await recordPledges(doc, new Map(villages.map((v) => [String(v._id), v.unitPath])));
  }
  await audit({
    action: 'JADWAL_CORRECT',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'jadwal',
    targetId: String(doc._id),
    unitPath: doc.unitPath,
    details: {
      date: doc.date,
      ajeerCode: doc.ajeerCode,
      reason: body.reason,
      changes,
      before,
      after,
    },
  });
  return serializeJadwal(doc);
}
