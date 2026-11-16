// Wusooli per donor in the Excel reports (CTO 16 Nov 2026): one line per wusooli entry of the
// submitted days in the scope and period — date, zimmedar, Gaon, donor, naqd, jins. Entries with a
// mad (saved before 13 Nov 2026) have no donor and are left out. Never a donor's mobile.
import type ExcelJS from 'exceljs';
import type { Types } from 'mongoose';
import { escapeRegex } from '../../lib/scope.js';
import { Donor } from '../../models/donor.js';
import { Jadwal } from '../../models/jadwal.js';

export interface DonorWusooliRow {
  date: string;
  ajeerCode: string;
  village: string;
  donor: string;
  naqd: number;
  jins: string;
  jinsValue: number;
}

/** Rows for a unit (its path and below) or one zimmedar, from `from` to `to` (Karachi dates). */
export async function donorWusooli(
  scope: { unitPath: string } | { userId: Types.ObjectId },
  from: string,
  to: string,
): Promise<DonorWusooliRow[]> {
  const match =
    'unitPath' in scope
      ? { unitPath: { $regex: `^${escapeRegex(scope.unitPath)}(/|$)` } }
      : { userId: scope.userId };
  const rows = await Jadwal.aggregate<{
    date: string;
    ajeerCode: string;
    village: string;
    e: {
      kind: 'naqd' | 'jins';
      amount: number;
      detail?: string;
      qty?: number;
      unit?: string;
      donorId?: Types.ObjectId;
      newDonorName?: string;
    };
  }>([
    { $match: { ...match, status: 'submitted', date: { $gte: from, $lte: to } } },
    { $unwind: '$visits' },
    { $unwind: '$visits.atiyat.entries' },
    {
      $match: {
        'visits.atiyat.entries.type': 'wusooli',
        'visits.atiyat.entries.category': { $exists: false },
      },
    },
    {
      $project: {
        _id: 0,
        date: 1,
        ajeerCode: 1,
        village: '$visits.villageName',
        e: '$visits.atiyat.entries',
      },
    },
    { $sort: { date: 1, ajeerCode: 1 } },
    { $limit: 20_000 },
  ]);
  const ids = rows.flatMap((r) => (r.e.donorId ? [r.e.donorId] : []));
  const names = new Map(
    (
      await Donor.find({ _id: { $in: ids } })
        .select('name')
        .lean()
    ).map((d) => [String(d._id), d.name]),
  );
  return rows.map((r) => ({
    date: r.date,
    ajeerCode: r.ajeerCode,
    village: r.village,
    donor: (r.e.donorId ? names.get(String(r.e.donorId)) : r.e.newDonorName) ?? '',
    naqd: r.e.kind === 'naqd' ? r.e.amount : 0,
    jins:
      r.e.kind === 'jins'
        ? `${r.e.qty ?? ''} ${r.e.unit ?? ''} ${r.e.detail ?? ''}`.replace(/ +/g, ' ').trim()
        : '',
    jinsValue: r.e.kind === 'jins' ? r.e.amount : 0,
  }));
}

/** A "Donor wusooli" sheet (Roman Urdu headers, like the dashboard). */
export function addDonorWusooliSheet(wb: ExcelJS.Workbook, rows: DonorWusooliRow[]): void {
  const ws = wb.addWorksheet('Donor wusooli', { views: [{ state: 'frozen', ySplit: 1 }] });
  const head = ws.addRow(['Tareekh', 'Ajeer code', 'Gaon', 'Donor', 'Naqd', 'Jins', 'Jins qeemat']);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEBFB' } };
  for (const r of rows) {
    ws.addRow([r.date, r.ajeerCode, r.village, r.donor, r.naqd, r.jins, r.jinsValue]);
  }
  ws.addRow([
    'Kul',
    '',
    '',
    `${rows.length} indiraj`,
    rows.reduce((s, r) => s + r.naqd, 0),
    '',
    rows.reduce((s, r) => s + r.jinsValue, 0),
  ]).font = { bold: true };
  [12, 12, 26, 26, 12, 24, 12].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getColumn(5).numFmt = '#,##0';
  ws.getColumn(7).numFmt = '#,##0';
}
