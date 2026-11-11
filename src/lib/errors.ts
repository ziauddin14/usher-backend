import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { z } from 'zod';

/** Stable error codes (API doc "Common codes"). Apps translate them; never rename one. */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_INACTIVE'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'VILLAGE_EXISTS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'JADWAL_LOCKED'
  | 'RATE_LIMITED'
  | 'DB_UNAVAILABLE'
  | 'INTERNAL';

/** The MongoDB driver could not reach the database (server down, wrong URI, network). */
function isDbUnavailable(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return /^Mongo(ose)?(ServerSelection|Network|NetworkTimeout|TopologyClosed)Error$/.test(name);
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Parse request input with zod; throws VALIDATION_FAILED with the issues. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Request validation failed', {
      issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  }
  return result.data;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'Route not found'));
};

/** Last middleware: every error becomes `{ error: { code, message, details? } }`. */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }
  // Malformed JSON body from express.json()
  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } });
    return;
  }
  // A body over the route's limit (express.json / express.raw).
  if (err instanceof Error && 'type' in err && err.type === 'entity.too.large') {
    res.status(413).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request body too large',
        details: { reason: 'TOO_LARGE' },
      },
    });
    return;
  }
  // No database: a clear 503 (the screens say "server is not reachable"), not a generic 500.
  if (isDbUnavailable(err)) {
    console.error(`[db] database not reachable: ${(err as Error).name}`);
    res
      .status(503)
      .json({ error: { code: 'DB_UNAVAILABLE', message: 'Database is not reachable' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};
