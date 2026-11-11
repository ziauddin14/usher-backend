import { z } from 'zod';
import { refineRange } from '../../lib/date-range.js';
import { isDateString } from '../../lib/time.js';

/** range = a custom range `from` … `date` (CTO 11 Nov 2026). */
export const PERIODS = ['day', 'week', 'month', 'reward', 'range'] as const;
export type SummaryPeriod = (typeof PERIODS)[number];

const date = z.string().refine(isDateString, 'must be a YYYY-MM-DD date');

export const summaryQuery = z
  .object({
    period: z.enum(PERIODS).default('day'),
    date: date.optional(),
    /** First day of a range (period=range only). */
    from: date.optional(),
  })
  .superRefine(refineRange);
