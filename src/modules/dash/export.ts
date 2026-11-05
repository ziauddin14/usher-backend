// GET /dash/export.xlsx — the dashboard tables as Excel (Roman Urdu headers, as on the screen)
// with a totals row. Data comes from the same service functions as the screens.
import ExcelJS from 'exceljs';
import type { AuthUser } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import type { Kpis } from '../me/service.js';
import type { DashPeriod } from './schemas.js';
import { childrenTable, type TodayStatus, zimmedarDays, zimmedaranTable } from './service.js';

const TODAY_TEXT: Record<TodayStatus, string> = {
  jama: 'Jama',
  jari: 'Jari hai',
  nahi: 'Nahi aaya',
  rukhsat: 'Rukhsat',
  course: 'Course',
  qafila: 'Qafila',
  mashwara_full: 'Mashwara',
};

type Cell = string | number | null;

async function workbook(title: string, header: string[], rows: Cell[][], totals: Cell[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.addRow([title]).font = { bold: true, size: 13 };
  const head = ws.addRow(header);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEBFB' } };
  for (const r of rows) ws.addRow(r);
  ws.addRow(totals).font = { bold: true };
  ws.columns.forEach((c, i) => {
    c.width = i === 0 ? 26 : 14;
    c.numFmt = '#,##0';
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const sum = (rows: { kpis: Kpis }[], key: keyof Kpis) => rows.reduce((s, r) => s + r.kpis[key], 0);

export async function dashExport(
  caller: AuthUser,
  q: {
    view: 'children' | 'zimmedaran' | 'days';
    code?: string;
    userId?: string;
    period: DashPeriod;
    date?: string;
    month?: string;
  },
): Promise<{ file: Buffer; name: string }> {
  if (q.view === 'days') {
    if (!q.userId) throw new AppError(400, 'VALIDATION_FAILED', 'userId is required');
    const d = await zimmedarDays(caller, q.userId, q.month);
    const submitted = d.days.filter((x) => x.totals);
    const kpi = (key: keyof Kpis) =>
      submitted.reduce((s, x) => s + Number((x.totals as Partial<Kpis> | null)?.[key] ?? 0), 0);
    const file = await workbook(
      `${d.user.name} · Ajeer ${d.user.ajeerCode} · ${d.month}`,
      [
        'Tareekh',
        'Status',
        'Qism',
        'Gaon',
        'Naye donors',
        'Purane',
        'Niyyat',
        'Wusooli (kul)',
        'Reward wali',
        'KM',
        'Kiraya',
      ],
      d.days.map((x) => {
        const t = (x.totals ?? {}) as Partial<Kpis>;
        return [
          x.date,
          x.status === 'submitted' ? 'Jama' : 'Jari hai',
          x.entryType,
          x.villages.join(', '),
          t.newDonors ?? null,
          t.oldDonors ?? null,
          t.niyyat ?? null,
          t.wusooli ?? null,
          t.rewardWusooli ?? null,
          t.km ?? null,
          t.fare ?? null,
        ];
      }),
      [
        'Kul',
        `${submitted.length} din`,
        '',
        '',
        kpi('newDonors'),
        kpi('oldDonors'),
        kpi('niyyat'),
        kpi('wusooli'),
        kpi('rewardWusooli'),
        kpi('km'),
        kpi('fare'),
      ],
    );
    return { file, name: `ushr-${d.user.ajeerCode}-${d.month}.xlsx` };
  }

  if (!q.code) throw new AppError(400, 'VALIDATION_FAILED', 'code is required');
  if (q.view === 'zimmedaran') {
    const t = await zimmedaranTable(caller, q.code, q.period, q.date);
    const file = await workbook(
      `${t.unit.name} — Zimmedaran · ${t.from} – ${t.to}`,
      [
        'Zimmedar',
        'Ajeer code',
        'Unit',
        'Aaj',
        'Gaon',
        'Naye donors',
        'Purane',
        'Niyyat',
        'Wusooli (kul)',
        'Reward wali',
        '6-mah avg',
        'Reward status',
      ],
      t.rows.map((r) => [
        r.name,
        r.ajeerCodeFull ?? r.ajeerCode,
        r.unitCode,
        TODAY_TEXT[r.today],
        r.kpis.villages,
        r.kpis.newDonors,
        r.kpis.oldDonors,
        r.kpis.niyyat,
        r.kpis.wusooli,
        r.kpis.rewardWusooli,
        r.avg,
        r.reward.kind === 'earned'
          ? `Rs ${r.reward.amount} ✓`
          : r.reward.kind === 'qareeb'
            ? 'Qareeb'
            : 'Peeche',
      ]),
      [
        'Kul',
        `${t.rows.length} zimmedaran`,
        '',
        '',
        sum(t.rows, 'villages'),
        sum(t.rows, 'newDonors'),
        sum(t.rows, 'oldDonors'),
        sum(t.rows, 'niyyat'),
        sum(t.rows, 'wusooli'),
        sum(t.rows, 'rewardWusooli'),
        '',
        '',
      ],
    );
    return { file, name: `ushr-${t.unit.code}-${t.period}-${t.date}.xlsx` };
  }

  const c = await childrenTable(caller, q.code, q.period, q.date);
  const tiers = c.rows[0]?.onTrack.map((o) => o.amount) ?? [];
  const file = await workbook(
    `${c.unit.name} — ${c.childLevel} · ${c.from} – ${c.to}`,
    [
      'Unit',
      'Zimmedaran',
      'Jadwal jama (aaj)',
      'Field activity (aaj)',
      'Gaon visits',
      'Naye donors',
      'Wusooli (kul)',
      'Reward wali',
      ...tiers.map((a) => `Rs ${a} wale`),
    ],
    c.rows.map((r) => [
      r.unit.name,
      r.zimmedaran,
      r.today.submitted,
      r.today.field,
      r.kpis.villages,
      r.kpis.newDonors,
      r.kpis.wusooli,
      r.kpis.rewardWusooli,
      ...r.onTrack.map((o) => o.count),
    ]),
    [
      'Kul',
      c.rows.reduce((s, r) => s + r.zimmedaran, 0),
      c.rows.reduce((s, r) => s + r.today.submitted, 0),
      c.rows.reduce((s, r) => s + r.today.field, 0),
      sum(c.rows, 'villages'),
      sum(c.rows, 'newDonors'),
      sum(c.rows, 'wusooli'),
      sum(c.rows, 'rewardWusooli'),
      ...tiers.map((_, i) => c.rows.reduce((s, r) => s + (r.onTrack[i]?.count ?? 0), 0)),
    ],
  );
  return { file, name: `ushr-${c.unit.code}-${c.period}-${c.date}.xlsx` };
}
