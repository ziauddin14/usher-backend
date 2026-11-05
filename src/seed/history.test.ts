import { beforeAll, describe, expect, it } from 'vitest';
import { Jadwal } from '../models/jadwal.js';
import { User } from '../models/user.js';
import { computeDayTotals } from '../modules/reports/calc.js';
import { DEFAULT_SETTINGS } from '../modules/settings/defaults.js';
import { DEMO_MONTHLY, seedHistory } from './history.js';
import { seedDemo } from './seed.js';

const TODAY = '2026-11-01';
/** One other invented zimmedar of Ghotki next to the demo zimmedar. */
let other: string;

async function monthly(ajeerCode: string): Promise<Record<string, number>> {
  const rows = await Jadwal.aggregate<{ _id: string; amount: number }>([
    { $match: { ajeerCode, status: 'submitted' } },
    { $group: { _id: '$month', amount: { $sum: '$totals.rewardWusooli' } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r.amount]));
}

describe('seedHistory (invented jadwal history, Dec 2025 → yesterday)', () => {
  beforeAll(async () => {
    await seedDemo({ reset: true });
    const z = await User.findOne({
      role: 'zimmedar',
      unitCode: 'GHOTKI',
      ajeerCode: { $ne: '9090412' },
    })
      .sort({ ajeerCode: 1 })
      .lean();
    other = z!.ajeerCode;
    await seedHistory(TODAY, { ajeerCodes: ['9090412', other] });
  });

  it('gives 9090412 the exact monthly reward wusooli of both periods', async () => {
    const m = await monthly('9090412');
    for (const [month, amount] of Object.entries(DEMO_MONTHLY)) expect(m[month]).toBe(amount);
  });

  it('covers 1 Dec 2025 → yesterday, never today, all submitted, no real people', async () => {
    const first = await Jadwal.findOne({ ajeerCode: other }).sort({ date: 1 }).lean();
    const last = await Jadwal.findOne({ ajeerCode: other }).sort({ date: -1 }).lean();
    expect(first!.date >= '2025-12-01').toBe(true);
    expect(first!.date <= '2025-12-05').toBe(true);
    expect(last!.date <= '2026-10-31').toBe(true); // yesterday at most
    expect(await Jadwal.countDocuments({ date: TODAY })).toBe(0);
    expect(await Jadwal.countDocuments({ status: { $ne: 'submitted' } })).toBe(0);
    // Only invented 7-digit demo codes.
    const codes: string[] = await Jadwal.distinct('ajeerCode');
    expect(codes.every((c) => /^9\d{6}$/.test(c))).toBe(true);
  });

  it('stores totals computed by computeDayTotals, not typed by hand', async () => {
    const days = await Jadwal.find({ ajeerCode: other, entryType: 'amli' }).limit(25).lean();
    expect(days.length).toBe(25);
    for (const d of days) {
      expect(d.totals).toMatchObject(computeDayTotals(d, DEFAULT_SETTINGS.atiyatCategories));
    }
  });

  it('re-running on a later day only adds later days and keeps finished months exact', async () => {
    const before = await monthly('9090412');
    const otherBefore = await monthly(other);
    const added = await seedHistory('2026-11-06', { ajeerCodes: ['9090412', other] });
    expect(added.jadwals).toBeGreaterThan(0);
    const after = await monthly('9090412');
    const otherAfter = await monthly(other);
    for (const month of Object.keys(before)) expect(after[month]).toBe(before[month]);
    for (const month of Object.keys(otherBefore))
      expect(otherAfter[month]).toBe(otherBefore[month]);
    expect(await Jadwal.countDocuments({ date: { $gte: '2026-11-06' } })).toBe(0);
    // Running it again the same day adds nothing.
    expect((await seedHistory('2026-11-06', { ajeerCodes: ['9090412', other] })).jadwals).toBe(0);
  });

  it('a month continued on a later day equals the same month seeded in one run', async () => {
    const z = await User.findOne({ role: 'zimmedar', unitCode: 'SUKKUR_DIST' })
      .sort({ ajeerCode: 1 })
      .lean();
    const code = z!.ajeerCode;
    const novDays = async () =>
      (await Jadwal.find({ ajeerCode: code, month: '2026-11' }).sort({ date: 1 }).lean()).map(
        (d) => [d.date, d.entryType, d.totals?.rewardWusooli],
      );
    await seedHistory('2026-11-04', { ajeerCodes: [code] });
    await seedHistory('2026-11-12', { ajeerCodes: [code] });
    const twoRuns = await novDays();
    await Jadwal.deleteMany({ ajeerCode: code });
    await seedHistory('2026-11-12', { ajeerCodes: [code] });
    expect(await novDays()).toEqual(twoRuns);
  });

  it('never adds days to a finished month that already has records (older generators)', async () => {
    const z = await User.findOne({ role: 'zimmedar', unitCode: 'KHAIRPUR' })
      .sort({ ajeerCode: 1 })
      .lean();
    // An October seeded earlier by another generator: one day only.
    await Jadwal.create({
      userId: z!._id,
      ajeerCode: z!.ajeerCode,
      unitPath: z!.unitPath,
      date: '2026-10-05',
      month: '2026-10',
      entryType: 'rukhsat',
      status: 'submitted',
      startedAt: new Date('2026-10-05T04:00:00Z'),
      submittedAt: new Date('2026-10-05T04:00:00Z'),
      visits: [],
    });
    await seedHistory(TODAY, { ajeerCodes: [z!.ajeerCode] });
    expect(await Jadwal.countDocuments({ ajeerCode: z!.ajeerCode, month: '2026-10' })).toBe(1);
    expect(
      await Jadwal.countDocuments({ ajeerCode: z!.ajeerCode, month: '2026-09' }),
    ).toBeGreaterThan(15);
  });
});
