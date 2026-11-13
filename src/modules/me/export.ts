// GET /me/export.xlsx — one row per day with Urdu headers, right-to-left sheet, totals row.
import ExcelJS from 'exceljs';
import { addTaskSheet, type TaskCounts } from '../reports/tasks.js';
import type { Kpis } from './service.js';

/** Urdu text of the export (backend file, not a UI component). */
const ENTRY_UR: Record<string, string> = {
  amli: 'عملی جدول',
  rukhsat: 'رخصت',
  course: 'کورس',
  qafila: 'قافلہ',
  mashwara_full: 'مشورہ (پورا دن)',
};
const NO_RECORD = 'ریکارڈ نہیں';

const COLUMNS: { header: string; key: keyof Kpis | 'date' | 'entryType'; width: number }[] = [
  { header: 'تاریخ', key: 'date', width: 13 },
  { header: 'قسم', key: 'entryType', width: 16 },
  { header: 'گاؤں', key: 'villages', width: 8 },
  { header: 'پرانے ڈونرز', key: 'oldDonors', width: 12 },
  { header: 'نئے ڈونرز', key: 'newDonors', width: 11 },
  { header: 'نیت (روپے)', key: 'niyyat', width: 13 },
  { header: 'وصولی (روپے)', key: 'wusooli', width: 14 },
  { header: 'انعام والی وصولی', key: 'rewardWusooli', width: 16 },
  { header: 'GSB بکس', key: 'gsbBoxes', width: 10 },
  { header: 'GSB رقم', key: 'gsbAmount', width: 12 },
  { header: 'اجتماع', key: 'ijtimas', width: 9 },
  { header: 'مشورہ', key: 'mashwaras', width: 9 },
  { header: 'کلومیٹر', key: 'km', width: 10 },
  { header: 'کرایہ', key: 'fare', width: 10 },
];

export async function buildMeWorkbook(input: {
  title: string;
  rows: {
    date: string;
    day: { entryType: string; totals?: Partial<Record<keyof Kpis, number | null>> | null } | null;
  }[];
  totals: Kpis;
  /** Task counts of the same days → a "کام" sheet. */
  tasks?: TaskCounts;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('خلاصہ', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 2 }],
  });
  ws.columns = COLUMNS.map(({ key, width }) => ({ key, width }));
  ws.addRow([input.title]).font = { bold: true, size: 13 };
  const header = ws.addRow(COLUMNS.map((c) => c.header));
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEBFB' } };

  for (const { date, day } of input.rows) {
    if (!day) {
      ws.addRow({ date, entryType: NO_RECORD });
      continue;
    }
    const t = day.totals ?? {};
    ws.addRow({
      date,
      entryType: ENTRY_UR[day.entryType] ?? day.entryType,
      ...Object.fromEntries(COLUMNS.slice(2).map((c) => [c.key, t[c.key as keyof Kpis] ?? 0])),
    });
  }
  // A period without any submitted jadwal is "no record", not a row of zeros.
  const hasRecord = input.rows.some((r) => r.day);
  const total = ws.addRow(
    hasRecord ? { date: 'کل', ...input.totals } : { date: 'کل', entryType: NO_RECORD },
  );
  total.font = { bold: true };
  for (const c of COLUMNS.slice(5)) {
    if (['niyyat', 'wusooli', 'rewardWusooli', 'gsbAmount', 'fare'].includes(c.key)) {
      ws.getColumn(c.key).numFmt = '#,##0';
    }
  }
  if (input.tasks) addTaskSheet(wb, input.tasks, true);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
