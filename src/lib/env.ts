import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// or mongodb+srv:// URI'),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ALLOWED_ORIGIN: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validated environment, read on first use (serverless-friendly: nothing runs at import). */
export function env(): Env {
  if (!cached) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
    }
    cached = result.data;
  }
  return cached;
}

/** Tests change process.env between files. */
export function resetEnvCache(): void {
  cached = undefined;
}
