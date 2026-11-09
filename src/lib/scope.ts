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

/** Segments of a District unit path: PK / suba / division / district. */
const DISTRICT_DEPTH = 4;

/**
 * The District unit path at or above `unitPath` (PK/<suba>/<division>/<district>), or null above
 * District level. Gaon are owned at District level; an Ushar Zimmedar under a Tehsil
 * (…/<district>/<tehsil>) still works with the Gaon of their District. The one place that decides
 * this — never compare a user's unitPath with a village's unitPath directly.
 */
export function districtPathOf(unitPath: string): string | null {
  const parts = unitPath.split('/');
  return parts.length >= DISTRICT_DEPTH ? parts.slice(0, DISTRICT_DEPTH).join('/') : null;
}

/** The District code of a District / Tehsil / Ushar unitPath (its fourth segment), or null. */
export function districtCodeOf(unitPath: string): string | null {
  const d = districtPathOf(unitPath);
  return d ? d.split('/')[DISTRICT_DEPTH - 1]! : null;
}

/** Out-of-scope ids answer 404 so callers cannot probe other units. */
export function assertInScope(user: Scoped, target: Scoped | null | undefined): asserts target {
  if (!target || !isInScope(user, target.unitPath)) {
    throw new AppError(404, 'NOT_FOUND', 'Not found');
  }
}
