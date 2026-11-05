import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings/defaults.js';
import { periodFor, periodResult, previousPeriod, rewardStatus } from './reward.js';

const rules = DEFAULT_SETTINGS.reward;

const SCOPE_EXAMPLE = [
  { month: '2026-06', amount: 185_000 },
  { month: '2026-07', amount: 210_000 },
  { month: '2026-08', amount: 160_000 },
  { month: '2026-09', amount: 245_000 },
  { month: '2026-10', amount: 198_000 },
];

describe('reward periods', () => {
  it('H1 = 1 Dec – 31 May (1 Dec belongs to the next year’s H1), H2 = 1 Jun – 30 Nov', () => {
    expect(periodFor('2026-12-01', rules)).toMatchObject({ id: 'H1', key: 'H1-2027' });
    expect(periodFor('2026-12-01', rules).months[0]).toBe('2026-12');
    expect(periodFor('2027-05-31', rules)).toMatchObject({ id: 'H1', key: 'H1-2027' });
    expect(periodFor('2027-06-01', rules)).toMatchObject({ id: 'H2', key: 'H2-2027' });
    expect(periodFor('2026-11-30', rules).months).toEqual([
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(periodFor('2026-05-31', rules).months.at(-1)).toBe('2026-05');
    expect(previousPeriod(periodFor('2026-10-31', rules), rules)).toMatchObject({
      key: 'H1-2026',
      months: ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05'],
    });
  });
});

describe('rewardStatus (average = period total ÷ 6, CTO 5 Nov 2026)', () => {
  it('scope §4 example: total 998,000 → average 166,333; Nov needs 202,000 and 802,000', () => {
    const s = rewardStatus(SCOPE_EXAMPLE, rules, '2026-10-31');
    expect(s).toMatchObject({
      periodId: 'H2',
      total: 998_000,
      monthsPassed: 5,
      runningAvg: 166_333, // 998,000 ÷ 6 rounded down — never ÷ 5
      remainingMonths: ['2026-11'],
      earned: 0,
    });
    expect(s.tiers).toEqual([
      expect.objectContaining({ amount: 5_000, needed: 202_000, perMonthNeeded: 202_000 }),
      expect.objectContaining({ amount: 10_000, needed: 802_000, perMonthNeeded: 802_000 }),
    ]);
    expect(s.tiers[0]!.progress).toBeCloseTo(998_000 / 1_200_000);
    expect(s.months.at(-1)).toEqual({ month: '2026-11', amount: 0, state: 'future' });
  });

  it("includes the current month's records and never estimates future months", () => {
    const s = rewardStatus(
      [...SCOPE_EXAMPLE, { month: '2026-11', amount: 12_000 }],
      rules,
      '2026-11-05',
    );
    expect(s).toMatchObject({ total: 1_010_000, monthsPassed: 6, runningAvg: 168_333 });
    expect(s.remainingMonths).toEqual(['2026-11']);
    expect(s.tiers[0]).toMatchObject({ needed: 190_000, perMonthNeeded: 190_000 });
    // A record dated in a future month is ignored.
    const early = rewardStatus(SCOPE_EXAMPLE, rules, '2026-08-10');
    expect(early.total).toBe(185_000 + 210_000 + 160_000);
    expect(early.runningAvg).toBe(Math.floor(555_000 / 6));
  });

  it('a month with no data counts as 0', () => {
    const s = rewardStatus(
      SCOPE_EXAMPLE.filter((m) => m.month !== '2026-08'),
      rules,
      '2026-10-31',
    );
    expect(s.total).toBe(838_000);
    expect(s.runningAvg).toBe(Math.floor(838_000 / 6));
  });

  it('exact thresholds: 1,200,000 earns Rs 5,000; 1,199,999 earns nothing; 1,800,000 earns Rs 10,000', () => {
    const at = (amount: number) =>
      rewardStatus([{ month: '2026-06', amount }], rules, '2026-11-20');
    expect(at(1_200_000)).toMatchObject({ runningAvg: 200_000, earned: 5_000 });
    expect(at(1_200_000).tiers[0]).toMatchObject({ achieved: true, needed: 0, progress: 1 });
    expect(at(1_199_999)).toMatchObject({ runningAvg: 199_999, earned: 0 });
    expect(at(1_199_999).tiers[0]).toMatchObject({ achieved: false, needed: 1 });
    expect(at(1_799_999)).toMatchObject({ earned: 5_000 });
    expect(at(1_800_000)).toMatchObject({ runningAvg: 300_000, earned: 10_000 });
  });

  it('a tier already reached → achieved, needed 0', () => {
    const s = rewardStatus([{ month: '2026-06', amount: 1_300_000 }], rules, '2026-07-10');
    expect(s.tiers[0]).toMatchObject({
      amount: 5_000,
      achieved: true,
      needed: 0,
      perMonthNeeded: 0,
    });
    expect(s.tiers[1]).toMatchObject({ amount: 10_000, achieved: false, needed: 500_000 });
  });

  it('more than one month left → perMonthNeeded = ceil(needed / monthsLeft)', () => {
    const s = rewardStatus([{ month: '2026-06', amount: 100_001 }], rules, '2026-07-15');
    expect(s.remainingMonths).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(s.tiers[0]!.needed).toBe(1_099_999);
    expect(s.tiers[0]!.perMonthNeeded).toBe(Math.ceil(1_099_999 / 4));
  });

  it('H1 runs across the year end (Dec 2025 – May 2026)', () => {
    const s = rewardStatus(
      [
        { month: '2025-12', amount: 300_000 },
        { month: '2026-01', amount: 300_000 },
        { month: '2025-11', amount: 999_999 }, // H2-2025, not this period
      ],
      rules,
      '2026-01-31',
    );
    expect(s).toMatchObject({ periodKey: 'H1-2026', total: 600_000, monthsPassed: 2 });
    expect(s.runningAvg).toBe(100_000);
  });
});

describe('periodResult', () => {
  it('uses total ÷ 6 and the highest tier reached exactly', () => {
    const h1 = periodFor('2026-03-01', rules);
    const monthly = h1.months.map((month) => ({ month, amount: 214_000 }));
    expect(periodResult(monthly, rules, h1)).toMatchObject({
      total: 1_284_000,
      avg: 214_000,
      amount: 5_000,
    });
    expect(periodResult([], rules, h1)).toMatchObject({ total: 0, avg: 0, amount: 0 });
  });

  it('never rounds up into a tier', () => {
    const h1 = periodFor('2026-03-01', rules);
    expect(periodResult([{ month: '2026-01', amount: 1_199_999 }], rules, h1)).toMatchObject({
      avg: 199_999,
      amount: 0,
    });
    expect(periodResult([{ month: '2026-01', amount: 1_800_000 }], rules, h1)).toMatchObject({
      avg: 300_000,
      amount: 10_000,
    });
  });
});
