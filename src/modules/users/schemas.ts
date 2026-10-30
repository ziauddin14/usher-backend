import { z } from 'zod';

export const listUsersQuery = z.object({
  unit: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .optional(),
  q: z.string().trim().max(60).optional(),
});
