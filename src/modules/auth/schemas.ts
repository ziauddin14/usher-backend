import { z } from 'zod';

/** First password of every imported / reset user (CTO decision 30 Oct 2026). */
export const INITIAL_PASSWORD = '123';
export const PASSWORD_MIN_LENGTH = 6;

const ajeerCode = z
  .string()
  .trim()
  .regex(/^\d{3,9}$/, 'digits only');

export const loginSchema = z.object({
  ajeerCode,
  password: z.string().min(1).max(128),
  /** Required while the user still has the initial password (mustChangePassword). */
  mobile: z.string().trim().max(20).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(128),
});

export const forgotPasswordSchema = z.object({
  ajeerCode,
  mobile: z.string().trim().min(1).max(20),
});
