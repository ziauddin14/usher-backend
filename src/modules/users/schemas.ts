import { z } from 'zod';

export const listUsersQuery = z.object({
  unit: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .optional(),
  q: z.string().trim().max(60).optional(),
});

export const statusSchema = z.object({ isActive: z.boolean() });

export const userIdParams = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });

/** POST /users (Admin): a new zimmedar. The mobile is optional (no verification). */
export const createUserSchema = z.object({
  ajeerCode: z.string().trim().regex(/^[0-9]{3,9}$/),
  name: z.string().trim().min(2).max(100),
  nameUr: z.string().trim().max(100).optional(),
  fatherName: z.string().trim().max(100).optional(),
  mobile: z
    .string()
    .trim()
    .regex(/^03[0-9]{9}$/)
    .optional(),
  districtCode: z.string().regex(/^[A-Z0-9_]+$/),
  zimmedari: z.enum(['ushar', 'tehsil_town']),
});
