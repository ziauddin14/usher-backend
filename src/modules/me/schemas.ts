import { z } from 'zod';
import { isDateString } from '../../lib/time.js';

export const PERIODS = ['day', 'week', 'month'] as const;
export type SummaryPeriod = (typeof PERIODS)[number];

export const summaryQuery = z.object({
  period: z.enum(PERIODS).default('day'),
  date: z.string().refine(isDateString, 'must be a YYYY-MM-DD date').optional(),
});
