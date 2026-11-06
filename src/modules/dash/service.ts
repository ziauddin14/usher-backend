// Supervisor dashboards (scope §5, B1 / B2). Every number comes from submitted jadwals of the
// zimmedaran currently in the unit; the reward status uses the same rewardStatus() as A12.
// Scope: the unit must be the caller's own unit or below it (404 otherwise).
import { Types } from 'mongoose';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { assertInScope, escapeRegex } from '../../lib/scope.js';
import { getRewardRules, getSettings } from '../../lib/settings.js';
import { karachiDate } from '../../lib/time.js';
import { Jadwal } from '../../models/jadwal.js';
import { Unit, type UnitLevel } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { KPI_KEYS, type Kpis, periodRange } from '../me/service.js';
import { periodFor, type RewardRules, rewardStatus } from '../reports/reward.js';
import type { DashPeriod } from './schemas.js';

const LEVEL_ORDER: UnitLevel[] = ['pakistan', 'suba', 'division', 'district'];

/** Submitted today (any entry type). */
const SUBMITTED = new Set<TodayStatus>(['jama', 'rukhsat', 'course', 'qafila', 'mashwara_full']);
/**
 * Submitted today as field activity (CTO 5 Nov 2026): amli, qafila, course. Never rukhsat. Full-day
 * mashwara is submission only: it may count as field activity only once it is officially confirmed
 * as duty, and Demo v1 has no such confirmation yet (requirement documented, no flag invented).
 */
const FIELD = new Set<TodayStatus>(['jama', 'course', 'qafila']);

/** Whole percent of n out of `of`, rounded down and kept within 0–100. */
export function percent(n: number, of: number): number {
  if (of <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((n * 100) / of)));
}

export type TodayStatus =
  'jama' | 'jari' | 'nahi' | 'rukhsat' | 'course' | 'qafila' | 'mashwara_full';

/** Reward status pill (scope §5 B1): a tier reached, "qareeb", or "peeche". */
export type RewardPill =
  { kind: 'earned'; amount: number } | { kind: 'qareeb' } | { kind: 'peeche' };

export interface ZimmedarRow {
  id: string;
  ajeerCode: string;
  ajeerCodeFull?: string;
  name: string;
  nameUr?: string;
  zimmedari?: string;
  unitCode: string;
  today: TodayStatus;
  /** Submitted jadwal days in the period (any entry type). */
  recordDays: number;
  kpis: Kpis;
  /** Six-month period total ÷ divisor (same as A12). */
  avg: number;
  periodTotal: number;
  reward: RewardPill;
}

interface UnitInfo {
  code: string;
  name: string;
  nameUr?: string;
  level: UnitLevel;
  path: string;
}

const emptyKpis = (): Kpis => Object.fromEntries(KPI_KEYS.map((k) => [k, 0])) as Kpis;
const pathRegex = (path: string) => ({ $regex: `^${escapeRegex(path)}(/|$)` });

/** The unit by code, if it is the caller's own unit or below it (404 otherwise). */
export async function unitInScope(caller: AuthUser, code: string): Promise<UnitInfo> {
  await connectDb();
  const unit = await Unit.findOne({ code }).select('code name nameUr level path').lean();
  assertInScope(caller, unit ? { unitPath: unit.path } : null);
  return {
    code: unit!.code,
    name: unit!.name,
    ...(unit!.nameUr ? { nameUr: unit!.nameUr } : {}),
    level: unit!.level,
    path: unit!.path,
  };
}

/** Breadcrumb from the caller's own unit down to `unit` (never above the caller). */
async function breadcrumb(caller: AuthUser, unit: UnitInfo) {
  const codes = unit.path.split('/');
  const units = await Unit.find({ code: { $in: codes } })
    .select('code name nameUr level path')
    .lean();
  const byCode = new Map(units.map((u) => [u.code, u]));
  return codes
    .map((c) => byCode.get(c))
    .filter((u): u is NonNullable<typeof u> => !!u && u.path.length >= caller.unitPath.length)
    .map((u) => ({ code: u.code, name: u.name, nameUr: u.nameUr ?? null, level: u.level }));
}

/** Kpis of one aggregation row (missing totals count as 0). */
function kpisOf(row: Record<string, unknown>): Kpis {
  const k = emptyKpis();
  for (const key of KPI_KEYS) k[key] = Number(row[key] ?? 0);
  return k;
}

function pillOf(
  runningAvg: number,
  earned: number,
  rules: RewardRules,
  nearPct: number,
): RewardPill {
  if (earned > 0) return { kind: 'earned', amount: earned };
  const lowest = [...rules.tiers].sort((a, b) => a.minAvg - b.minAvg)[0];
  if (lowest && runningAvg >= nearPct * lowest.minAvg) return { kind: 'qareeb' };
  return { kind: 'peeche' };
}

/**
 * Rows for every active zimmedar whose unit path is `path` or below it, for the period around
 * `date`. Shared by the zimmedaran table (B1), the children table (B2) and the KPI tiles.
 */
async function zimmedarRows(path: string, period: DashPeriod, date: string) {
  const settings = await getSettings();
  const rules = await getRewardRules();
  const today = karachiDate();
  const day = date > today ? today : date;
  const { from, to } = periodRange(period, day, today, settings.weekStartsOn, rules);

  // One row per unique active zimmedar of the unit: this is the denominator of both percentages,
  // and every count below is per person (a jadwal of an inactive or moved user is not counted).
  const users = await User.find({ role: 'zimmedar', isActive: true, unitPath: pathRegex(path) })
    .select('ajeerCode ajeerCodeFull name nameUr zimmedari unitCode unitPath')
    .sort({ unitPath: 1, name: 1 })
    .lean();
  const ids = users.map((u) => u._id);
  const reward = periodFor(today, rules);

  const sums = Object.fromEntries(
    KPI_KEYS.map((k) => [k, { $sum: { $ifNull: [`$totals.${k}`, 0] } }]),
  );
  const [inRange, todays, monthly] = await Promise.all([
    Jadwal.aggregate<Record<string, unknown> & { _id: Types.ObjectId; days: number }>([
      { $match: { userId: { $in: ids }, status: 'submitted', date: { $gte: from, $lte: to } } },
      { $group: { _id: '$userId', days: { $sum: 1 }, ...sums } },
    ]),
    Jadwal.find({ userId: { $in: ids }, date: today })
      .select('userId status entryType')
      .lean(),
    Jadwal.aggregate<{ _id: { u: Types.ObjectId; m: string }; amount: number }>([
      { $match: { userId: { $in: ids }, status: 'submitted', month: { $in: reward.months } } },
      {
        $group: {
          _id: { u: '$userId', m: '$month' },
          amount: { $sum: { $ifNull: ['$totals.rewardWusooli', 0] } },
        },
      },
    ]),
  ]);

  const rangeBy = new Map(inRange.map((r) => [String(r._id), r]));
  const todayBy = new Map(todays.map((j) => [String(j.userId), j]));
  const monthsBy = new Map<string, { month: string; amount: number }[]>();
  for (const m of monthly) {
    const key = String(m._id.u);
    monthsBy.set(key, [...(monthsBy.get(key) ?? []), { month: m._id.m, amount: m.amount }]);
  }

  const rows: (ZimmedarRow & { unitPath: string })[] = users.map((u) => {
    const id = String(u._id);
    const r = rangeBy.get(id);
    const t = todayBy.get(id);
    const todayStatus: TodayStatus = !t
      ? 'nahi'
      : t.status === 'draft'
        ? 'jari'
        : t.entryType === 'amli'
          ? 'jama'
          : t.entryType;
    const status = rewardStatus(monthsBy.get(id) ?? [], rules, today);
    return {
      id,
      ajeerCode: u.ajeerCode,
      ...(u.ajeerCodeFull ? { ajeerCodeFull: u.ajeerCodeFull } : {}),
      name: u.name,
      ...(u.nameUr ? { nameUr: u.nameUr } : {}),
      ...(u.zimmedari ? { zimmedari: u.zimmedari } : {}),
      unitCode: u.unitCode,
      unitPath: u.unitPath,
      today: todayStatus,
      recordDays: r?.days ?? 0,
      kpis: r ? kpisOf(r) : emptyKpis(),
      avg: status.runningAvg,
      periodTotal: status.total,
      reward: pillOf(status.runningAvg, status.earned, rules, settings.reward?.nearPct ?? 0),
    };
  });
  return { rows, from, to, today, period, date: day, reward, rules };
}

/** KPI tiles of a set of rows (scope §5 B1 / B2). */
function tilesOf(rows: ZimmedarRow[], rules: RewardRules) {
  const kpis = emptyKpis();
  for (const r of rows) for (const k of KPI_KEYS) kpis[k] += r.kpis[k];
  const tiers = [...rules.tiers].sort((a, b) => a.minAvg - b.minAvg);
  return {
    zimmedaran: rows.length,
    today: {
      jama: rows.filter((r) => r.today === 'jama').length,
      jari: rows.filter((r) => r.today === 'jari').length,
      nahi: rows.filter((r) => r.today === 'nahi').length,
      other: rows.filter((r) => !['jama', 'jari', 'nahi'].includes(r.today)).length,
      /**
       * Jadwal Submission % numerator: zimmedaran with a submitted jadwal today, any entry type
       * (rukhsat included — it measures the record, not leave approval).
       */
      submitted: rows.filter((r) => SUBMITTED.has(r.today)).length,
      /**
       * Field Activity % numerator: submitted amli, qafila or course — never rukhsat, and
       * full-day mashwara only after official duty confirmation (not available yet).
       * Drafts ("jari") and no record count in neither.
       */
      field: rows.filter((r) => FIELD.has(r.today)).length,
      /** submitted ÷ zimmedaran (rows are unique active zimmedaran), 0–100, rounded down. */
      submittedPct: percent(rows.filter((r) => SUBMITTED.has(r.today)).length, rows.length),
      /** field ÷ zimmedaran, 0–100, rounded down. */
      fieldPct: percent(rows.filter((r) => FIELD.has(r.today)).length, rows.length),
    },
    /** Submitted jadwal days in the period (all zimmedaran together). */
    recordDays: rows.reduce((s, r) => s + r.recordDays, 0),
    kpis,
    /** How many zimmedaran have reached each tier now (highest tier reached counts). */
    onTrack: tiers.map((t) => ({
      amount: t.amount,
      count: rows.filter((r) => r.reward.kind === 'earned' && r.reward.amount === t.amount).length,
    })),
  };
}

/** Calendar days in [from, to] (inclusive). */
function daysIn(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/** GET /dash/units/:code/overview */
export async function overview(caller: AuthUser, code: string, period: DashPeriod, date?: string) {
  const unit = await unitInScope(caller, code);
  const data = await zimmedarRows(unit.path, period, date ?? karachiDate());
  return {
    unit,
    breadcrumb: await breadcrumb(caller, unit),
    period: data.period,
    date: data.date,
    today: data.today,
    from: data.from,
    to: data.to,
    calendarDays: daysIn(data.from, data.to),
    rewardPeriod: { key: data.reward.key, months: data.reward.months },
    tiles: tilesOf(data.rows, data.rules),
  };
}

/** GET /dash/units/:code/zimmedaran — the B1 table (a district, or any unit for its zimmedaran). */
export async function zimmedaranTable(
  caller: AuthUser,
  code: string,
  period: DashPeriod,
  date?: string,
) {
  const unit = await unitInScope(caller, code);
  const data = await zimmedarRows(unit.path, period, date ?? karachiDate());
  return {
    unit,
    period: data.period,
    date: data.date,
    from: data.from,
    to: data.to,
    rewardPeriod: { key: data.reward.key, months: data.reward.months },
    rows: data.rows.map(({ unitPath: _p, ...r }) => r),
  };
}

/** GET /dash/units/:code/children — the B2 table: one row per child unit. */
export async function childrenTable(
  caller: AuthUser,
  code: string,
  period: DashPeriod,
  date?: string,
) {
  const unit = await unitInScope(caller, code);
  if (unit.level === 'district') {
    throw new AppError(400, 'VALIDATION_FAILED', 'A district has no child units — use /zimmedaran');
  }
  const children = await Unit.find({ parentCode: unit.code, isActive: true })
    .select('code name nameUr level path')
    .sort({ name: 1 })
    .lean();
  const data = await zimmedarRows(unit.path, period, date ?? karachiDate());
  const rows = children.map((c) => {
    const mine = data.rows.filter(
      (r) => r.unitPath === c.path || r.unitPath.startsWith(`${c.path}/`),
    );
    return {
      unit: { code: c.code, name: c.name, nameUr: c.nameUr ?? null, level: c.level, path: c.path },
      ...tilesOf(mine, data.rules),
    };
  });
  return {
    unit,
    childLevel: LEVEL_ORDER[LEVEL_ORDER.indexOf(unit.level) + 1] ?? 'district',
    period: data.period,
    date: data.date,
    from: data.from,
    to: data.to,
    rows,
  };
}

/** Zimmedar in the caller's scope (404 otherwise). */
async function zimmedarInScope(caller: AuthUser, userId: string) {
  await connectDb();
  const user = Types.ObjectId.isValid(userId)
    ? await User.findOne({ _id: userId, role: 'zimmedar' })
        .select('ajeerCode ajeerCodeFull name nameUr zimmedari unitCode unitPath isActive')
        .lean()
    : null;
  assertInScope(caller, user);
  return user;
}

/** GET /dash/zimmedaran/:userId/days?month — every jadwal of the month (drafts too) with totals. */
export async function zimmedarDays(caller: AuthUser, userId: string, month?: string) {
  const user = await zimmedarInScope(caller, userId);
  const m = month ?? karachiDate().slice(0, 7);
  const days = await Jadwal.find({ userId: user._id, month: m })
    .select('date status entryType totals visits.villageName reopened')
    .sort({ date: 1 })
    .lean();
  return {
    user: {
      id: String(user._id),
      ajeerCode: user.ajeerCode,
      ajeerCodeFull: user.ajeerCodeFull ?? null,
      name: user.name,
      nameUr: user.nameUr ?? null,
      zimmedari: user.zimmedari ?? null,
      unitCode: user.unitCode,
      isActive: user.isActive,
    },
    month: m,
    days: days.map((d) => ({
      id: String(d._id),
      date: d.date,
      status: d.status,
      entryType: d.entryType,
      villages: d.visits.map((v) => v.villageName),
      totals: d.status === 'submitted' ? (d.totals ?? null) : null,
      reopened: (d.reopened ?? []).length,
    })),
  };
}

/**
 * GET /dash/units/:code/villages?month — per zimmedar: assigned villages and the ones without a
 * submitted visit in that month; plus the district-pool villages (no zimmedar).
 */
export async function unitVillages(caller: AuthUser, code: string, month?: string) {
  const unit = await unitInScope(caller, code);
  const m = month ?? karachiDate().slice(0, 7);
  const [users, villages, visited] = await Promise.all([
    User.find({ role: 'zimmedar', isActive: true, unitPath: pathRegex(unit.path) })
      .select('ajeerCode name nameUr unitCode')
      .sort({ name: 1 })
      .lean(),
    Village.find({ unitPath: pathRegex(unit.path), status: { $in: ['approved', 'pending'] } })
      .select('name status assignedTo districtCode')
      .sort({ nameKey: 1 })
      .lean(),
    Jadwal.aggregate<{ _id: Types.ObjectId }>([
      { $match: { unitPath: pathRegex(unit.path), month: m, status: 'submitted' } },
      { $unwind: '$visits' },
      { $group: { _id: '$visits.villageId' } },
    ]),
  ]);
  const seen = new Set(visited.map((v) => String(v._id)));
  const item = (v: (typeof villages)[number]) => ({
    id: String(v._id),
    name: v.name,
    status: v.status,
    districtCode: v.districtCode,
    visited: seen.has(String(v._id)),
  });
  return {
    unit,
    month: m,
    zimmedaran: users.map((u) => {
      const mine = villages.filter((v) => String(v.assignedTo) === String(u._id)).map(item);
      return {
        id: String(u._id),
        ajeerCode: u.ajeerCode,
        name: u.name,
        nameUr: u.nameUr ?? null,
        unitCode: u.unitCode,
        assigned: mine.length,
        notVisited: mine.filter((v) => !v.visited),
        villages: mine,
      };
    }),
    pool: villages.filter((v) => !v.assignedTo).map(item),
    /** Assigned to someone who is no longer an active zimmedar here (deactivated or moved). */
    orphaned: villages
      .filter((v) => v.assignedTo && !users.some((u) => String(u._id) === String(v.assignedTo)))
      .map(item),
  };
}
