// Zimmedar's own khulasa (A11), reward tracker (A12) and Excel export. Always calculated from the
// submitted jadwals; a day without a jadwal is "no record" (never zero, never leave).
// Scope: the caller's own userId — narrower than any unit path, and a zimmedar moved to another
// district (re-import) keeps the history recorded under the old one.
import { Types } from 'mongoose';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { getRewardRules, getSettings } from '../../lib/settings.js';
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
import { taskCounts } from '../reports/tasks.js';
import { pledgeReport } from '../donors/pledges.js';
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
 * day = that day · week = the week (settings.weekStartsOn, Monday) · month = the calendar month ·
 * reward = the six-month reward period (settings.reward.periods) ·
 * range = `rangeFrom` … `date` (CTO 11 Nov 2026; checked by refineRange).
 */
export function periodRange(
  period: SummaryPeriod,
  date: string,
  today: string,
  weekStartsOn: number,
  rules: Pick<RewardRules, 'periods'>,
  rangeFrom?: string,
): { from: string; to: string } {
  const clamp = (d: string) => (d > today ? today : d);
  if (period === 'day') return { from: date, to: date };
  if (period === 'range') return { from: rangeFrom ?? date, to: clamp(date) };
  if (period === 'week') {
    const from = addDays(date, -((weekday(date) - weekStartsOn + 7) % 7));
    return { from, to: clamp(addDays(from, 6)) };
  }
  if (period === 'reward') {
    const { months } = periodFor(date, rules);
    return { from: `${months[0]!}-01`, to: clamp(monthEnd(`${months.at(-1)!}-01`)) };
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
export async function summary(
  user: AuthUser,
  opts: { period: SummaryPeriod; date?: string; from?: string },
) {
  const settings = await getSettings();
  const today = karachiDate();
  const date = opts.date && opts.date < today ? opts.date : today;
  const { from, to } = periodRange(
    opts.period,
    date,
    today,
    settings.weekStartsOn,
    await getRewardRules(),
    opts.from,
  );

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

/** GET /me/reward — current period status + previous period result. */
export async function reward(user: AuthUser) {
  const rules = await getRewardRules();
  const today = karachiDate();
  const period = periodFor(today, rules);
  const prev = previousPeriod(period, rules);

  await connectDb();
  const rows = await Jadwal.aggregate<{ _id: string; amount: number; days: number }>([
    {
      $match: {
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
  const status = rewardStatus(monthly, rules, today);
  /** Submitted days in a month (0 = no record at all that month). */
  const daysOf = (month: string) => rows.find((r) => r._id === month)?.days ?? 0;
  return {
    today,
    /** settings.reward.divisor, for the "کل ÷ N" labels. */
    divisor: rules.divisor,
    ...status,
    months: status.months.map((m) => ({ ...m, recordDays: daysOf(m.month) })),
    previous: {
      ...periodResult(monthly, rules, prev),
      recordDays: rows.filter((r) => prevMonths.has(r._id)).reduce((s, r) => s + r.days, 0),
    },
  };
}

/** Rows for GET /me/export.xlsx: every day of the period (null = no record) + totals. */
export async function exportRows(
  user: AuthUser,
  opts: { period: SummaryPeriod; date?: string; from?: string },
) {
  const settings = await getSettings();
  const today = karachiDate();
  const date = opts.date && opts.date < today ? opts.date : today;
  const { from, to } = periodRange(
    opts.period,
    date,
    today,
    settings.weekStartsOn,
    await getRewardRules(),
    opts.from,
  );
  const days = await submittedDays(user, from, to);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const rows: { date: string; day: DayRow | null }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) rows.push({ date: d, day: byDate.get(d) ?? null });
  return { from, to, date, rows, totals: sumKpis(days) };
}

/** GET /me/tasks — own meeting-task and other-work counts in the period (CTO 13 Nov 2026). */
export async function myTasks(
  user: AuthUser,
  opts: { period: SummaryPeriod; date?: string; from?: string },
) {
  await connectDb();
  const settings = await getSettings();
  const today = karachiDate();
  const date = opts.date && opts.date < today ? opts.date : today;
  const { from, to } = periodRange(
    opts.period,
    date,
    today,
    settings.weekStartsOn,
    await getRewardRules(),
    opts.from,
  );
  return { from, to, ...(await taskCounts({ userId: new Types.ObjectId(user.id), from, to })) };
}

/** GET /me/pledges — own niyyat (CTO 13 Nov 2026). */
export async function myPledges(
  user: AuthUser,
  opts: { period: SummaryPeriod; date?: string; from?: string },
) {
  await connectDb();
  const settings = await getSettings();
  const today = karachiDate();
  const date = opts.date && opts.date < today ? opts.date : today;
  const span = periodRange(
    opts.period,
    date,
    today,
    settings.weekStartsOn,
    await getRewardRules(),
    opts.from,
  );
  return pledgeReport({ userId: new Types.ObjectId(user.id) }, span);
}
