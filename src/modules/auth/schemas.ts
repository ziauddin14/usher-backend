import { z } from 'zod';

export const loginSchema = z.object({
  ajeerCode: z
    .string()
    .trim()
    .regex(/^\d{3,9}$/, 'digits only'),
  password: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8, 'at least 8 characters').max(128),
});
