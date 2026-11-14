import { z } from 'zod';
import { AUDIT_ACTIONS } from '../../models/audit-log.js';

const date = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);

export const auditQuery = z.object({
  actor: z
    .string()
    .regex(/^[0-9]{1,12}$/)
    .optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  /** "1" includes logins and password / mobile changes (left out by default). */
  logins: z
    .enum(['0', '1'])
    .optional()
    .transform((v) => v === '1'),
  from: date.optional(),
  to: date.optional(),
  /** Ajeer Code (or its start) of the user the entry is about. */
  target: z
    .string()
    .regex(/^[0-9]{1,12}$/)
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
