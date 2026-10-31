import { z } from 'zod';

export const listUsersQuery = z.object({
  unit: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .optional(),
  q: z.string().trim().max(60).optional(),
  /** none = no number yet · unverified = typed at first login, waiting for the District */
  mobileStatus: z.enum(['verified', 'unverified', 'none']).optional(),
});

export const userIdParams = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });
