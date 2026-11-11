// A custom date range for reports (CTO 11 Nov 2026): `period=range&from=YYYY-MM-DD&date=YYYY-MM-DD`
// (`date` = the last day; today when missing). Shared by the zimmedar's Khulasa (/me) and the
// dashboards (/dash) so both check it the same way.
import type { z } from 'zod';
import { addDays, karachiDate } from './time.js';

/** Longest range a report may cover (a year). */
export const MAX_RANGE_DAYS = 366;

/** Inclusive number of days in [from, to]. */
export function rangeDays(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/**
 * zod superRefine for a query with `period`, `date?` and `from?`: a range needs `from`, starts on
 * or before its last day and not after today, and covers at most MAX_RANGE_DAYS days. `from` is
 * ignored for every other period.
 */
export function refineRange(
  q: { period: string; date?: string | undefined; from?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (q.period !== 'range') return;
  const today = karachiDate();
  const to = q.date && q.date < today ? q.date : today;
  if (!q.from) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'from is required for a range' });
    return;
  }
  if (q.from > to) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: 'from must be on or before the last day',
    });
    return;
  }
  if (rangeDays(q.from, to) > MAX_RANGE_DAYS) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: `a range covers at most ${MAX_RANGE_DAYS} days (from ${addDays(to, 1 - MAX_RANGE_DAYS)} for this end)`,
    });
  }
}
