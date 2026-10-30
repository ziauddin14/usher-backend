import { AppError } from './errors.js';

/** Anything with a unit path: the caller, a jadwal, a village, a unit. */
export interface Scoped {
  unitPath: string;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `path` is the caller's own unit path or below it. */
export function isInScope(user: Scoped, path: string): boolean {
  return path === user.unitPath || path.startsWith(`${user.unitPath}/`);
}

/**
 * Mongo filter limiting a query to the caller's subtree:
 * `{ unitPath: { $regex: '^P(/|$)' } }` — an anchored prefix, so it can use the unitPath index.
 * Use it in every query on operational data.
 */
export function scopeFilter(user: Scoped, field = 'unitPath'): Record<string, { $regex: string }> {
  return { [field]: { $regex: `^${escapeRegex(user.unitPath)}(/|$)` } };
}

/** Out-of-scope ids answer 404 so callers cannot probe other units. */
export function assertInScope(user: Scoped, target: Scoped | null | undefined): asserts target {
  if (!target || !isInScope(user, target.unitPath)) {
    throw new AppError(404, 'NOT_FOUND', 'Not found');
  }
}
