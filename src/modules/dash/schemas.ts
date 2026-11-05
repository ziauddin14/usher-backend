import { z } from 'zod';
import { isDateString } from '../../lib/time.js';

export const DASH_PERIODS = ['day', 'week', 'month'] as const;
export type DashPeriod = (typeof DASH_PERIODS)[number];

const date = z.string().refine(isDateString, 'must be a YYYY-MM-DD date');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');

export const unitParams = z.object({ code: z.string().regex(/^[A-Z0-9_]{2,40}$/) });
export const userParams = z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/i) });

export const periodQuery = z.object({
  period: z.enum(DASH_PERIODS).default('day'),
  date: date.optional(),
});

export const monthQuery = z.object({ month: month.optional() });

export const exportQuery = z.object({
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
  month: month.optional(),
});
