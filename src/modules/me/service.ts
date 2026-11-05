// Zimmedar's own khulasa (A11), reward tracker (A12) and Excel export. Always calculated from the
// submitted jadwals; a day without a jadwal is "no record" (never zero, never leave).
import { Types } from 'mongoose';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { scopeFilter } from '../../lib/scope.js';
import { getSettings } from '../../lib/settings.js';
import { addDays, karachiDate, weekday } from '../../lib/time.js';
import { Jadwal } from '../../models/jadwal.js';
import type { DayTotals } from '../reports/calc.js';
import {
  periodFor,
  periodResult,
  previousPeriod,
  type RewardRules,
  rewardStatus,
} from '../reports/reward.js';
import type { SummaryPeriod } from './schemas.js';

export const KPI_KEYS = [
  'villages',
  'oldDonors',
  'newDonors',
  'niyyat',
  'wusooli',
  'rewardWusooli',
  'excludedWusooli',
  'gsbBoxes',
  'gsbAmount',
  'ijtimas',
  'mashwaras',
  'km',
  'fare',
] as const satisfies readonly (keyof DayTotals)[];
export type Kpis = Record<(typeof KPI_KEYS)[number], number>;

const emptyKpis = (): Kpis => Object.fromEntries(KPI_KEYS.map((k) => [k, 0])) as Kpis;

/** Last day of the month of a YYYY-MM-DD date. */
function monthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Date range of a period around `date` (Karachi days), never past today:
 * day = that day · week = the week (settings.weekStartsOn, Monday) · month = the calendar month.
 */
export function periodRange(
  period: SummaryPeriod,
  date: string,
  today: string,
  weekStartsOn: number,
): { from: string; to: string } {
  const clamp = (d: string) => (d > today ? today : d);
  if (period === 'day') return { from: date, to: date };
  if (period === 'week') {
    const from = addDays(date, -((weekday(date) - weekStartsOn + 7) % 7));
    return { from, to: clamp(addDays(from, 6)) };
  }
  return { from: `${date.slice(0, 7)}-01`, to: clamp(monthEnd(date)) };
}

interface DayRow {
  date: string;
  entryType: string;
  totals?: Partial<Record<keyof DayTotals, number | null>> | null;
}

/** Own submitted jadwals in [from, to], oldest first. */
async function submittedDays(user: AuthUser, from: string, to: string): Promise<DayRow[]> {
  await connectDb();
  return Jadwal.find({
    ...scopeFilter(user),
    userId: new Types.ObjectId(user.id),
    status: 'submitted',
    date: { $gte: from, $lte: to },
  })
    .select('date entryType totals')
    .sort({ date: 1 })
    .lean();
}

function sumKpis(days: DayRow[]): Kpis {
  const k = emptyKpis();
  for (const d of days) for (const key of KPI_KEYS) k[key] += d.totals?.[key] ?? 0;
  return k;
}

/** GET /me/summary — KPIs of the period + the last 7 days' wusooli (null = no record). */
export async function summary(user: AuthUser, opts: { period: SummaryPeriod; date?: string }) {
  const settings = await getSettings();
  const today = karachiDate();
  const date = opts.date && opts.date < today ? opts.date : today;
  const { from, to } = periodRange(opts.period, date, today, settings.weekStartsOn);

  const sevenFrom = addDays(date, -6);
  const days = await submittedDays(
    user,
    from < sevenFrom ? from : sevenFrom,
    to > date ? to : date,
  );
  const inRange = days.filter((d) => d.date >= from && d.date <= to);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(sevenFrom, i);
    const j = byDate.get(day);
    return { date: day, wusooli: j ? (j.totals?.wusooli ?? 0) : null };
  });

  return {
    period: opts.period,
    date,
    today,
    from,
    to,
    /** Days with a submitted jadwal (any entry type). */
    recordDays: inRange.length,
    amliDays: inRange.filter((d) => d.entryType === 'amli').length,
    kpis: sumKpis(inRange),
    last7Days,
  };
}

/** Plain reward rules from the settings document. */
async function rewardRules(): Promise<RewardRules> {
  const r = (await getSettings()).reward;
  if (!r) throw new AppError(500, 'INTERNAL', 'Reward settings missing');
  return {
    periods: r.periods.map((p) => ({ id: p.id, startMonth: p.startMonth, months: p.months })),
    divisor: r.divisor,
    tiers: r.tiers.map((t) => ({ minAvg: t.minAvg, amount: t.amount })),
  };
}

/** GET /me/reward — current period status + previous period result. */
export async function reward(user: AuthUser) {
  const rules = await rewardRules();
  const today = karachiDate();
  const period = periodFor(today, rules);
  const prev = previousPeriod(period, rules);

  await connectDb();
  const rows = await Jadwal.aggregate<{ _id: string; amount: number; days: number }>([
    {
      $match: {
        ...scopeFilter(user),
        userId: new Types.ObjectId(user.id),
        status: 'submitted',
        month: { $in: [...prev.months, ...period.months] },
      },
    },
    {
      $group: {
        _id: '$month',
        amount: { $sum: { $ifNull: ['$totals.rewardWusooli', 0] } },
        days: { $sum: 1 },
      },
    },
  ]);
  const monthly = rows.map((r) => ({ month: r._id, amount: r.amount }));
  const prevMonths = new Set(prev.months);
  return {
    today,
    ...rewardStatus(monthly, rules, today),
    previous: {
      ...periodResult(monthly, rules, prev),
      recordDays: rows.filter((r) => prevMonths.has(r._id)).reduce((s, r) => s + r.days, 0),
    },
  };
}

/** Rows for GET /me/export.xlsx: every day of the period (null = no record) + totals. */
export async function exportRows(user: AuthUser, opts: { period: SummaryPeriod; date?: string }) {
  const settings = await getSettings();
  const today = karachiDate();
  const date = opts.date && opts.date < today ? opts.date : today;
  const { from, to } = periodRange(opts.period, date, today, settings.weekStartsOn);
  const days = await submittedDays(user, from, to);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const rows: { date: string; day: DayRow | null }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) rows.push({ date: d, day: byDate.get(d) ?? null });
  return { from, to, date, rows, totals: sumKpis(days) };
}
