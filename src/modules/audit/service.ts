// GET /audit — the audit log for the Admin dashboard (CTO 14 Nov 2026): who changed what, so two
// Admins can see each other's work and a double change is caught. Newest first, paged, filtered by
// actor, action and Karachi date range. Never shows a password, token or full mobile (none is
// written to `details`). Login entries are left out unless asked for (they are many).
import type { z } from 'zod';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { escapeRegex, scopeFilter } from '../../lib/scope.js';
import { AuditLog } from '../../models/audit-log.js';
import { User } from '../../models/user.js';
import type { auditQuery } from './schemas.js';

const NOISY = ['LOGIN', 'LOGIN_FAILED', 'PASSWORD_CHANGE', 'MOBILE_UPDATE'];

/** Start of a Karachi (UTC+5, no DST) date as a UTC instant. */
const karachiStart = (date: string) => new Date(`${date}T00:00:00+05:00`);

export async function listAudit(caller: AuthUser, q: z.infer<typeof auditQuery>) {
  await connectDb();
  const filter: Record<string, unknown> = {};
  // Scope: entries about the caller's subtree, and entries with no unit (e.g. a migration).
  const scope = scopeFilter(caller) as { unitPath?: unknown };
  if (scope.unitPath) {
    filter.$or = [{ unitPath: scope.unitPath }, { unitPath: { $exists: false } }];
  }
  if (q.actor) filter.actorAjeerCode = q.actor;
  if (q.action) filter.action = q.action;
  else if (!q.logins) filter.action = { $nin: NOISY };
  if (q.from || q.to) {
    const at: Record<string, Date> = {};
    if (q.from) at.$gte = karachiStart(q.from);
    if (q.to) {
      const end = karachiStart(q.to);
      end.setUTCDate(end.getUTCDate() + 1);
      at.$lt = end;
    }
    filter.at = at;
  }
  if (q.target) {
    const re = { $regex: `^${escapeRegex(q.target)}` };
    filter.$and = [{ $or: [{ 'details.targetAjeerCode': re }, { 'details.ajeerCode': re }] }];
  }
  const pageSize = 50;
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ at: -1 })
      .skip((q.page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  const codes = [...new Set(items.map((i) => i.actorAjeerCode))];
  const actors = await User.find({ ajeerCode: { $in: codes } })
    .select('ajeerCode name role')
    .lean();
  const byCode = new Map(actors.map((a) => [a.ajeerCode, a]));
  return {
    page: q.page,
    pageSize,
    total,
    items: items.map((i) => {
      const actor = byCode.get(i.actorAjeerCode);
      return {
        id: String(i._id),
        at: i.at,
        action: i.action,
        actor: {
          ajeerCode: i.actorAjeerCode,
          name: actor?.name ?? null,
          role: actor?.role ?? null,
        },
        targetType: i.targetType ?? null,
        targetId: i.targetId ?? null,
        details: (i.details as Record<string, unknown> | undefined) ?? null,
      };
    }),
  };
}

/** The Admin accounts, for the actor filter of the audit screen. */
export async function listAdmins() {
  await connectDb();
  const admins = await User.find({ role: 'admin' })
    .select('ajeerCode name')
    .sort({ name: 1 })
    .lean();
  return admins.map((a) => ({ ajeerCode: a.ajeerCode, name: a.name }));
}
