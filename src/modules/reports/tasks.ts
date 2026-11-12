// Counts of meeting tasks and the day's other work in a period (CTO 13 Nov 2026: e.g. how many
// bags of toray / gattu, how many sharai heela). Always from submitted jadwals, so earlier days
// count too — never stored totals.
import type { Types } from 'mongoose';
import type ExcelJS from 'exceljs';
import { getDonorTasks, getOtherWork } from '../../lib/settings.js';
import { Jadwal } from '../../models/jadwal.js';
import type { DonorTaskDef } from '../settings/donor-tasks.js';

interface Pick {
  id: string;
  count?: number | null;
}

export interface TaskCountRow {
  id: string;
  labelUr: string;
  labelRoman: string;
  /** Meeting task: times ticked (per donor; the old-donor list without names counts once). */
  times: number;
  /** A count task (toray / gattu): the numbers added up (bags). Null for other tasks. */
  units: number | null;
  /** The count question's label (e.g. "کتنی بوریاں دیں"), for the units. */
  unitsLabelUr: string | null;
  unitsLabelRoman: string | null;
}

export interface OtherWorkRow {
  id: string;
  labelUr: string;
  labelRoman: string;
  /** Days on which it was done. */
  days: number;
}

export interface TaskCounts {
  meeting: TaskCountRow[];
  other: OtherWorkRow[];
  /** Submitted amli days counted. */
  days: number;
}

/** Task counts of the submitted amli jadwals that match (own user, or a unit path). */
export async function taskCounts(match: {
  userId?: Types.ObjectId;
  unitPath?: { $regex: string };
  from: string;
  to: string;
}): Promise<TaskCounts> {
  const [defs, otherDefs] = await Promise.all([getDonorTasks(), getOtherWork()]);
  const jadwals = await Jadwal.find({
    ...(match.userId ? { userId: match.userId } : {}),
    ...(match.unitPath ? { unitPath: match.unitPath } : {}),
    status: 'submitted',
    entryType: 'amli',
    date: { $gte: match.from, $lte: match.to },
  })
    .select(
      'otherTasks visits.donors.oldTasks visits.donors.met.tasks visits.donors.newDonors.tasks',
    )
    .lean();

  const times = new Map<string, number>();
  const units = new Map<string, number>();
  const days = new Map<string, number>();
  const tick = (p: Pick) => {
    times.set(p.id, (times.get(p.id) ?? 0) + 1);
    if (typeof p.count === 'number') units.set(p.id, (units.get(p.id) ?? 0) + p.count);
  };
  for (const j of jadwals) {
    for (const v of j.visits ?? []) {
      const d = v.donors;
      if (!d) continue;
      for (const p of d.oldTasks ?? []) tick(p);
      for (const m of d.met ?? []) for (const p of m.tasks ?? []) tick(p);
      for (const n of d.newDonors ?? []) for (const p of n.tasks ?? []) tick(p);
    }
    for (const p of j.otherTasks ?? []) days.set(p.id, (days.get(p.id) ?? 0) + 1);
  }

  const meetingRow = (d: DonorTaskDef): TaskCountRow => ({
    id: d.id,
    labelUr: d.labelUr,
    labelRoman: d.labelRoman,
    times: times.get(d.id) ?? 0,
    units: d.count ? (units.get(d.id) ?? 0) : null,
    unitsLabelUr: d.count?.labelUr ?? null,
    unitsLabelRoman: d.count?.labelRoman ?? null,
  });
  return {
    meeting: defs.map(meetingRow),
    other: otherDefs.map((d) => ({
      id: d.id,
      labelUr: d.labelUr,
      labelRoman: d.labelRoman,
      days: days.get(d.id) ?? 0,
    })),
    days: jadwals.length,
  };
}

/** A "Kaam" sheet for the Excel reports (Roman Urdu like the dashboard; Urdu for the zimmedar). */
export function addTaskSheet(wb: ExcelJS.Workbook, counts: TaskCounts, urdu = false): void {
  const ws = wb.addWorksheet(urdu ? 'کام' : 'Kaam', urdu ? { views: [{ rightToLeft: true }] } : {});
  const label = (r: { labelUr: string; labelRoman: string }) => (urdu ? r.labelUr : r.labelRoman);
  const head = (cells: string[]) => {
    const row = ws.addRow(cells);
    row.font = { bold: true };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEBFB' } };
  };
  head(
    urdu
      ? ['ملاقات کے کام', 'کتنی بار', 'تعداد (مثلاً بوریاں)']
      : ['Mulaqat ke kaam', 'Kitni baar', 'Tadaad (boriyan waghaira)'],
  );
  for (const r of counts.meeting) ws.addRow([label(r), r.times, r.units]);
  ws.addRow([]);
  head(urdu ? ['دیگر کام', 'کتنے دن'] : ['Deegar kaam', 'Kitne din']);
  for (const r of counts.other) ws.addRow([label(r), r.days]);
  ws.getColumn(1).width = 52;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 22;
}
