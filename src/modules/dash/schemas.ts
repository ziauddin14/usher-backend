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

const unitCode = z.string().regex(/^[A-Z0-9_]{2,40}$/);

/**
 * GET /dash/villages (CTO 17 Nov 2026): every Gaon in scope, filtered — Suba / Division / District,
 * zimmedar (assigned, pool, inactive zimmedar), problem (any, none, one kind), visit this month,
 * status, name. 50 per page.
 */
export const villageBrowseQuery = z.object({
  suba: unitCode.optional(),
  division: unitCode.optional(),
  district: unitCode.optional(),
  assigned: z.enum(['yes', 'no', 'orphaned']).optional(),
  issue: z
    .enum([
      'yes',
      'no',
      'ZIMMEDAR_NOT_FOUND',
      'NOT_IMPORTED_EMPLOYEE',
      'SUPERVISOR_CODE',
      'DISTRICT_MISMATCH',
      'SIMILAR_NAME',
    ])
    .optional(),
  visited: z.enum(['yes', 'no']).optional(),
  /** Missing information (CTO 17 Nov 2026). */
  info: z.enum(['noLocation', 'noLocalZimmedar', 'noCrops']).optional(),
  status: z.enum(['approved', 'pending']).optional(),
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type VillageBrowseQuery = z.infer<typeof villageBrowseQuery>;
