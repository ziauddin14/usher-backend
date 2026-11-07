import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    MONGODB_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// or mongodb+srv:// URI'),
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    ALLOWED_ORIGIN: z.string().optional(),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  })
  .superRefine((e, ctx) => {
    // Production never runs against a local database or a plain-http web origin by accident.
    if (e.NODE_ENV !== 'production') return;
    if (
      /^mongodb(\+srv)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(e.MONGODB_URI)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['MONGODB_URI'],
        message: 'is a local database in production',
      });
    }
    if (e.ALLOWED_ORIGIN && !e.ALLOWED_ORIGIN.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOWED_ORIGIN'],
        message: 'must be https:// in production',
      });
    }
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

/**
 * How many proxies in front of the API are trusted for the client IP (rate limits, audit logs).
 * 1 = one proxy (local / a single host). Render behind the Vercel /api rewrite = 2: Vercel puts
 * the real client IP into X-Forwarded-For and Render's own proxy adds the Vercel hop. Read at app
 * creation, so it is not part of env() (nothing else is needed at import time).
 */
export function trustProxyHops(source: NodeJS.ProcessEnv = process.env): number {
  const raw = source.TRUST_PROXY_HOPS;
  if (raw === undefined || raw === '') return 1;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error('Invalid environment: TRUST_PROXY_HOPS must be an integer 0–5');
  }
  return hops;
}

/** Tests change process.env between files. */
export function resetEnvCache(): void {
  cached = undefined;
}
