import { z } from 'zod';
import { refineRange } from '../../lib/date-range.js';
import { isDateString } from '../../lib/time.js';

/** range = a custom range `from` … `date` (CTO 11 Nov 2026). */
export const DASH_PERIODS = ['day', 'week', 'month', 'range'] as const;
export type DashPeriod = (typeof DASH_PERIODS)[number];

const date = z.string().refine(isDateString, 'must be a YYYY-MM-DD date');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');

export const unitParams = z.object({ code: z.string().regex(/^[A-Z0-9_]{2,40}$/) });
export const userParams = z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/i) });

export const periodQuery = z
  .object({
    period: z.enum(DASH_PERIODS).default('day'),
    date: date.optional(),
    /** First day of a range (period=range only). */
    from: date.optional(),
  })
  .superRefine(refineRange);

export const monthQuery = z.object({ month: month.optional() });

export const exportQuery = z
  .object({
    view: z.enum(['children', 'zimmedaran', 'days']),
    code: z
      .string()
      .regex(/^[A-Z0-9_]{2,40}$/)
      .optional(),
    userId: z
      .string()
      .regex(/^[a-f0-9]{24}$/i)
      .optional(),
    period: z.enum(DASH_PERIODS).default('day'),
    date: date.optional(),
    from: date.optional(),
    month: month.optional(),
  })
  .superRefine(refineRange);
