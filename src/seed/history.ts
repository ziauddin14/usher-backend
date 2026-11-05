// Invented jadwal history (data model "Seed" → Jadwals): 1 Dec 2025 → yesterday (Karachi) for
// every seeded zimmedar, i.e. the whole previous reward period (H1-2026) and the current one.
// Totals are computed with computeDayTotals, never typed by hand.
import { Types } from 'mongoose';
import { assertDemoDb } from '../lib/databases.js';
import { env } from '../lib/env.js';
import { getRewardRules, getSettings } from '../lib/settings.js';
import { addDays, karachiDate } from '../lib/time.js';
import { Jadwal } from '../models/jadwal.js';
import { User } from '../models/user.js';
import { Village } from '../models/village.js';
import { computeDayTotals } from '../modules/reports/calc.js';
import { periodFor } from '../modules/reports/reward.js';
import { FIRST, LAST, rng } from './data.js';

export const HISTORY_START = '2025-12-01';
export const DEMO_ZIMMEDAR = '9090412';

/**
 * The demo zimmedar's reward-eligible wusooli per month. H1-2026 (Dec–May) totals 1,284,000 →
 * average 214,000 → Rs 5,000 earned, as on the design's previous-period line (CTO 5 Nov 2026).
 */
export const DEMO_MONTHLY_H1: Record<string, number> = {
  '2025-12': 205_000,
  '2026-01': 198_000,
  '2026-02': 220_000,
  '2026-03': 231_000,
  '2026-04': 214_000,
  '2026-05': 216_000,
};
/** Jun–Oct 2026 exactly as in design A12 / scope §4. November is kept small. */
export const DEMO_MONTHLY_H2: Record<string, number> = {
  '2026-06': 185_000,
  '2026-07': 210_000,
  '2026-08': 160_000,
  '2026-09': 245_000,
  '2026-10': 198_000,
};
export const DEMO_MONTHLY: Record<string, number> = { ...DEMO_MONTHLY_H1, ...DEMO_MONTHLY_H2 };

/** Monthly reward-wusooli bands so every district has people in every reward status. */
const PROFILES = [
  { min: 310_000, max: 380_000 }, // Rs 10,000 tier
  { min: 205_000, max: 280_000 }, // Rs 5,000 tier
  { min: 172_000, max: 196_000 }, // "qareeb" (≥ 85% of 2 lakh)
  { min: 60_000, max: 150_000 }, // "peeche"
];

type Rand = () => number;
const between = (r: Rand, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
const pick = <T>(r: Rand, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
const roundTo = (v: number, step: number) => Math.round(v / step) * step;

/** Split `total` into `parts` integer amounts (multiples of `step`, last one takes the rest). */
function split(r: Rand, total: number, parts: number, step: number): number[] {
  if (parts <= 0) return [];
  const weights = Array.from({ length: parts }, () => 0.5 + r());
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => roundTo((total * w) / sum, step));
  const diff = total - out.reduce((a, b) => a + b, 0);
  // Put the rounding difference on the largest part so nothing goes negative.
  const largest = out.indexOf(Math.max(...out));
  out[largest] = out[largest]! + diff;
  return out;
}

function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

interface SeedVillage {
  _id: Types.ObjectId;
  name: string;
}

interface Category {
  id: string;
  rewardIncluded: boolean;
}

function buildVisit(
  r: Rand,
  village: SeedVillage,
  reward: number,
  cats: { included: string[]; excluded: string[] },
) {
  const entries: {
    type: 'niyyat' | 'wusooli';
    category: string;
    kind: 'naqd' | 'jins';
    amount: number;
    detail?: string;
  }[] = [];
  let gsb: { boxesOpened: number; amount: number } | undefined;
  let rest = reward;
  if (reward >= 2_000 && r() < 0.25) {
    const amount = roundTo(reward * (0.1 + r() * 0.15), 100);
    gsb = { boxesOpened: between(r, 1, 3), amount };
    rest -= amount;
  }
  for (const amount of split(r, rest, rest >= 6_000 && r() < 0.5 ? 2 : 1, 100)) {
    if (amount <= 0) continue;
    const category = pick(r, cats.included);
    const jins = category === 'ushr' && r() < 0.5;
    entries.push({
      type: 'wusooli',
      category,
      kind: jins ? 'jins' : 'naqd',
      amount,
      ...(jins ? { detail: pick(r, ['گندم', 'کپاس', 'چاول', 'گنا']) } : {}),
    });
  }
  // About 15% of the value goes to purposes outside the reward (tameer, FGRF, deg).
  if (reward > 0 && r() < 0.45) {
    const amount = roundTo(reward * (0.2 + r() * 0.25), 100);
    if (amount > 0) {
      entries.push({ type: 'wusooli', category: pick(r, cats.excluded), kind: 'naqd', amount });
    }
  }
  if (reward > 0 && r() < 0.6) {
    const amount = roundTo(reward * (2 + r() * 3), 500);
    if (amount > 0) {
      entries.push({ type: 'niyyat', category: pick(r, cats.included), kind: 'naqd', amount });
    }
  }
  const newDonors = Array.from({ length: r() < 0.55 ? between(r, 1, 2) : 0 }, () => ({
    name: `${pick(r, FIRST)[1]} ${pick(r, LAST)[1]}`,
    acres: between(r, 2, 25),
  }));
  const ijtima = r() < 0.3;
  const mashwara = r() < 0.35;
  return {
    _id: new Types.ObjectId(),
    villageId: village._id,
    villageName: village.name,
    donors: { oldMet: between(r, 0, 6), newDonors },
    atiyat: { entries, ...(gsb ? { gsb } : {}) },
    ijtima: ijtima
      ? { held: true, type: r() < 0.6 ? 'kisan' : 'zamindar', participants: between(r, 8, 30) }
      : { held: false },
    mashwara: mashwara ? { held: true, participants: between(r, 2, 8) } : { held: false },
    savedSteps: ['donors', 'atiyat', 'ijtima', 'mashwara'],
  };
}

export interface HistoryResult {
  jadwals: number;
}

/** Seed for one zimmedar's month: every month has its own random stream, so adding earlier
 * months or re-running later never changes the days generated for another month. */
const monthSeed = (ajeerCode: string, month: string) =>
  Number(ajeerCode) * 31 + Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));

/**
 * Seed the history for every demo zimmedar (idempotent). Days that already exist are kept, and a
 * month that already has records only gets days after its last record (so "no record" days stay
 * empty and finished months keep their exact figures). Never writes today — the demo starts
 * with "شروع نہیں ہوا".
 */
export async function seedHistory(
  today = karachiDate(),
  { ajeerCodes }: { ajeerCodes?: string[] } = {},
): Promise<HistoryResult> {
  assertDemoDb(env().MONGODB_URI); // invented history only ever goes into ushr_demo
  const settings = await getSettings();
  const categories: Category[] = settings.atiyatCategories.map((c) => ({
    id: c.id,
    rewardIncluded: c.rewardIncluded,
  }));
  const cats = {
    included: categories.filter((c) => c.rewardIncluded && c.id !== 'gsb').map((c) => c.id),
    excluded: categories.filter((c) => !c.rewardIncluded).map((c) => c.id),
  };
  const rules = await getRewardRules();
  const yesterday = addDays(today, -1);
  if (yesterday < HISTORY_START) return { jadwals: 0 };

  const zimmedaran = await User.find({ role: 'zimmedar', isDemo: true })
    .select('_id ajeerCode unitPath')
    .sort({ unitPath: 1, ajeerCode: 1 })
    .lean();
  const indexInDistrict = new Map<string, number>();
  const counters = new Map<string, number>();
  for (const z of zimmedaran) {
    if (z.ajeerCode === DEMO_ZIMMEDAR) continue;
    const i = counters.get(z.unitPath) ?? 0;
    indexInDistrict.set(z.ajeerCode, i);
    counters.set(z.unitPath, i + 1);
  }

  let inserted = 0;
  for (const z of zimmedaran) {
    if (ajeerCodes && !ajeerCodes.includes(z.ajeerCode)) continue;
    const existingDates = (await Jadwal.find({ userId: z._id }).select('date').lean()).map(
      (j) => j.date,
    );
    const existing = new Set(existingDates);
    const lastInMonth = new Map<string, string>();
    for (const d of existingDates) {
      const m = d.slice(0, 7);
      if (d > (lastInMonth.get(m) ?? '')) lastInMonth.set(m, d);
    }
    const own = await Village.find({ assignedTo: z._id, status: 'approved' })
      .select('_id name')
      .sort({ nameKey: 1 })
      .lean();
    const villages: SeedVillage[] =
      own.length > 0
        ? own
        : await Village.find({ unitPath: z.unitPath, status: 'approved' })
            .select('_id name')
            .lean();
    if (villages.length === 0) continue;

    const isDemo = z.ajeerCode === DEMO_ZIMMEDAR;
    const index = indexInDistrict.get(z.ajeerCode) ?? 0;
    // Each reward period gets its own band (shifted by one in H1), so the previous period shows
    // different outcomes from the current one.
    const bands = new Map<string, { profile: (typeof PROFILES)[number]; base: number }>();
    const bandFor = (month: string) => {
      const period = periodFor(month, rules);
      let band = bands.get(period.key);
      if (!band) {
        const shift = period.id === 'H1' ? 1 : 0;
        const profile = PROFILES[(index + shift) % PROFILES.length]!;
        const base = between(
          rng(monthSeed(z.ajeerCode, period.months[0]!)),
          profile.min,
          profile.max,
        );
        band = { profile, base };
        bands.set(period.key, band);
      }
      return band;
    };
    let meter = between(rng(Number(z.ajeerCode)), 20_000, 60_000);

    const docs: Record<string, unknown>[] = [];
    const days: { date: string; type: string }[] = [];
    for (
      let first = HISTORY_START;
      first <= yesterday;
      first = addDays(first, daysInMonth(first))
    ) {
      const month = first.slice(0, 7);
      const r = rng(monthSeed(z.ajeerCode, month));
      // The whole month is generated (day types first, so its reward amount can be spread over
      // its amli days) and only the days up to yesterday are stored: a later run adds exactly the
      // days a full run would have had, so a month never changes once seeded.
      const monthDays: { date: string; type: string }[] = [];
      for (let d = first; d.startsWith(month); d = addDays(d, 1)) {
        const x = r();
        const type =
          x < 0.7
            ? 'amli'
            : x < 0.78
              ? 'rukhsat'
              : x < 0.82
                ? 'qafila'
                : x < 0.84
                  ? 'course'
                  : x < 0.86
                    ? 'mashwara_full'
                    : 'none'; // no record that day
        monthDays.push({ date: d, type });
      }
      // The demo zimmedar's exact months need at least one amli day to carry the amount.
      if (isDemo && DEMO_MONTHLY[month] && !monthDays.some((d) => d.type === 'amli')) {
        monthDays[0]!.type = 'amli';
      }
      days.push(...monthDays);

      const amliDays = monthDays.filter((d) => d.type === 'amli');
      let monthReward: number;
      if (isDemo) {
        // Exact design numbers; later months stay small (data model "Seed").
        monthReward = DEMO_MONTHLY[month] ?? amliDays.length * 4_000;
      } else {
        const { profile, base } = bandFor(month);
        const variation = profile.min >= 172_000 && profile.max < 200_000 ? 0.04 : 0.1;
        monthReward = roundTo(base * (1 - variation + r() * 2 * variation), 500);
      }
      const perDay = split(r, monthReward, amliDays.length, 500);

      amliDays.forEach((day, i) => {
        const visitCount = Math.min(villages.length, between(r, 1, 3));
        const start = between(r, 0, villages.length - 1);
        const chosen = Array.from(
          { length: visitCount },
          (_, k) => villages[(start + k) % villages.length]!,
        );
        const visits = split(r, perDay[i] ?? 0, visitCount, 100).map((amount, k) =>
          buildVisit(r, chosen[k]!, amount, cats),
        );
        const bike = r() < 0.8;
        const km = between(r, 15, 90);
        const travel = bike
          ? { mode: 'bike' as const, meterStart: meter, meterEnd: meter + km, km }
          : { mode: 'bus' as const, fare: roundTo(between(r, 150, 600), 50) };
        if (bike) meter += km;
        const jadwal = { travel, visits };
        docs.push({
          date: day.date,
          entryType: 'amli',
          ...jadwal,
          totals: computeDayTotals(jadwal, categories),
        });
      });
    }
    for (const day of days) {
      if (day.type === 'amli' || day.type === 'none') continue;
      docs.push({
        date: day.date,
        entryType: day.type,
        visits: [],
        totals: computeDayTotals({ visits: [] }, categories),
      });
    }

    const toInsert = docs
      .filter((doc) => {
        const date = doc.date as string;
        const month = date.slice(0, 7);
        const last = lastInMonth.get(month);
        // A month with records is finished as it is (it may come from an older generator);
        // only the current month is continued after its last record.
        if (last && month !== today.slice(0, 7)) return false;
        return date <= yesterday && !existing.has(date) && date > (last ?? '');
      })
      .map((doc) => ({
        ...doc,
        userId: z._id,
        ajeerCode: z.ajeerCode,
        unitPath: z.unitPath,
        month: (doc.date as string).slice(0, 7),
        status: 'submitted',
        // 9:00 and 18:30 Karachi time (UTC+5).
        startedAt: new Date(`${doc.date as string}T04:00:00Z`),
        submittedAt: new Date(`${doc.date as string}T13:30:00Z`),
      }));
    if (toInsert.length > 0) {
      await Jadwal.insertMany(toInsert, { ordered: false });
      inserted += toInsert.length;
    }
  }
  return { jadwals: inserted };
}
