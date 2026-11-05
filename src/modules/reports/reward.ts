// Special reward (scope §4) — pure functions, no database access.
// Average = period total ÷ divisor (always 6; CTO 5 Nov 2026), current month included, future
// months never estimated. A tier is reached only when total ≥ minAvg × divisor exactly.

export interface RewardPeriodRule {
  id: string;
  /** 1–12: the calendar month the period starts in. */
  startMonth: number;
  months: number;
}

export interface RewardTierRule {
  minAvg: number;
  amount: number;
}

export interface RewardRules {
  periods: RewardPeriodRule[];
  divisor: number;
  tiers: RewardTierRule[];
}

export interface RewardPeriod {
  id: string;
  /** e.g. "H2-2026"; H1 of year Y starts in December of Y−1. */
  key: string;
  /** YYYY-MM of every month in the period, in order. */
  months: string[];
}

export interface MonthAmount {
  month: string;
  amount: number;
}

export interface TierStatus {
  amount: number;
  minAvg: number;
  /** minAvg × divisor — the period total needed for this tier. */
  target: number;
  /** target − total, never below 0 (integer rupees). */
  needed: number;
  /** needed spread evenly over the months still to come (ceil). */
  perMonthNeeded: number;
  /** Exact comparison: total ≥ target (no rounding up). */
  achieved: boolean;
  /** total ÷ target, capped at 1 (the bar on A12). */
  progress: number;
}

export interface RewardStatus {
  periodId: string;
  periodKey: string;
  months: (MonthAmount & { state: 'past' | 'current' | 'future' })[];
  total: number;
  /** Months of the period up to and including the current one. */
  monthsPassed: number;
  /** total ÷ divisor rounded down to whole rupees — the big number on A12 ("ماہانہ اوسط"). */
  runningAvg: number;
  /**
   * Months in which the still-needed amount can come: the months after the current one; in the
   * last month of the period, the current month itself.
   */
  remainingMonths: string[];
  /** Lowest tier first. */
  tiers: TierStatus[];
  /** Reward amount of the highest tier already reached (0 = none yet). */
  earned: number;
}

const ym = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

/** The reward period that contains `date` (YYYY-MM-DD or YYYY-MM). */
export function periodFor(date: string, rules: Pick<RewardRules, 'periods'>): RewardPeriod {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  for (const p of rules.periods) {
    // How many months after the period's start month this month is (0 … 11).
    const offset = (month - p.startMonth + 12) % 12;
    if (offset < p.months) {
      const startYear = month >= p.startMonth ? year : year - 1;
      return monthsOf(p, startYear);
    }
  }
  throw new Error(`No reward period contains ${date}`);
}

function monthsOf(p: RewardPeriodRule, startYear: number): RewardPeriod {
  const months: string[] = [];
  for (let i = 0; i < p.months; i += 1) {
    const m0 = p.startMonth - 1 + i;
    months.push(ym(startYear + Math.floor(m0 / 12), (m0 % 12) + 1));
  }
  // Named after the year the period ends in ("H1-2027" = Dec 2026 – May 2027).
  return { id: p.id, key: `${p.id}-${months.at(-1)!.slice(0, 4)}`, months };
}

/** The period just before `period`. */
export function previousPeriod(period: RewardPeriod, rules: Pick<RewardRules, 'periods'>) {
  const [y, m] = period.months[0]!.split('-').map(Number) as [number, number];
  return periodFor(m === 1 ? ym(y - 1, 12) : ym(y, m - 1), rules);
}

/** The highest tier whose exact target (minAvg × divisor) the total has reached. */
function highestTier(total: number, rules: RewardRules): RewardTierRule | undefined {
  return [...rules.tiers]
    .sort((a, b) => b.minAvg - a.minAvg)
    .find((t) => total >= t.minAvg * rules.divisor);
}

/**
 * Reward status for the period containing `today`. `monthly` = reward-eligible wusooli per month
 * (submitted jadwals only); a month without records counts as 0.
 */
export function rewardStatus(
  monthly: MonthAmount[],
  rules: RewardRules,
  today: string,
): RewardStatus {
  const period = periodFor(today, rules);
  const current = today.slice(0, 7);
  const byMonth = new Map(monthly.map((m) => [m.month, m.amount]));
  const months = period.months.map((month) => {
    const state: 'past' | 'current' | 'future' =
      month < current ? 'past' : month === current ? 'current' : 'future';
    return { month, amount: state === 'future' ? 0 : (byMonth.get(month) ?? 0), state };
  });
  const total = months.reduce((sum, m) => sum + m.amount, 0);
  const monthsPassed = months.filter((m) => m.state !== 'future').length;
  const future = months.filter((m) => m.state === 'future').map((m) => m.month);
  const remainingMonths = future.length > 0 ? future : [current];

  const tiers = [...rules.tiers]
    .sort((a, b) => a.minAvg - b.minAvg)
    .map((t) => {
      const target = t.minAvg * rules.divisor;
      const needed = Math.max(0, target - total);
      return {
        amount: t.amount,
        minAvg: t.minAvg,
        target,
        needed,
        perMonthNeeded: Math.ceil(needed / remainingMonths.length),
        achieved: total >= target,
        progress: target > 0 ? Math.min(1, total / target) : 0,
      };
    });

  return {
    periodId: period.id,
    periodKey: period.key,
    months,
    total,
    monthsPassed,
    runningAvg: Math.floor(total / rules.divisor),
    remainingMonths,
    tiers,
    earned: highestTier(total, rules)?.amount ?? 0,
  };
}

/** Result of a finished period: average = total ÷ divisor (rounded down); exact tier check. */
export function periodResult(monthly: MonthAmount[], rules: RewardRules, period: RewardPeriod) {
  const inPeriod = new Set(period.months);
  const total = monthly.filter((m) => inPeriod.has(m.month)).reduce((s, m) => s + m.amount, 0);
  return {
    periodId: period.id,
    periodKey: period.key,
    months: period.months,
    total,
    avg: Math.floor(total / rules.divisor),
    amount: highestTier(total, rules)?.amount ?? 0,
  };
}
