// Official-duty approval of a full-day mashwara (CTO 6 Nov 2026).
// A submitted full-day mashwara is Submission only until the owner's level directly above
// explicitly approves it as official duty; only then is it Field Activity. Rejected or undecided
// stays Submission only; a draft counts in neither. History is never approved automatically.
// This is its own rule: a mobile-verification permission grants nothing here.
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { scopeFilter } from '../../lib/scope.js';
import { Jadwal, type DutyDecision } from '../../models/jadwal.js';
import { ROLE_RANK, type Role, User } from '../../models/user.js';

/**
 * Who decides official duty for a mashwara, by the owner's role:
 *   zimmedar ← District · district ← Division · division ← Suba (the level directly above, in scope).
 *   suba / pakistan owners: no approver is authorized in Demo v1 (supervisors do not file jadwals;
 *   the CTO's suba ← designated Pakistan Admin and pakistan ← Central IT would need their own
 *   explicit permission first) → 403.
 * Never self, never same level, never any other higher level.
 */
export function assertDutyApprover(caller: AuthUser, owner: { _id: unknown; role: Role }): void {
  if (String(owner._id) === caller.id) {
    throw new AppError(403, 'FORBIDDEN', 'Nobody approves their own mashwara');
  }
  if (owner.role === 'suba' || owner.role === 'pakistan') {
    throw new AppError(
      403,
      'FORBIDDEN',
      'No official-duty approver is authorized for this level in Demo v1',
    );
  }
  if (ROLE_RANK[caller.role] !== ROLE_RANK[owner.role] + 1) {
    throw new AppError(403, 'FORBIDDEN', 'Only the level directly above approves official duty');
  }
}

export interface DutyView {
  status: DutyDecision;
  byAjeerCode: string;
  at: Date;
  reason: string | null;
}

/**
 * POST /jadwals/:id/duty-approval — approve or reject a submitted full-day mashwara as official
 * duty. Deciding again changes the decision (both audited). Audit MASHWARA_DUTY_APPROVE / _REJECT.
 */
export async function decideDuty(
  caller: AuthUser,
  id: string,
  body: { decision: 'approve' | 'reject'; reason?: string | undefined },
): Promise<DutyView> {
  await connectDb();
  const doc = await Jadwal.findOne({ _id: id, ...scopeFilter(caller) })
    .select('userId ajeerCode date unitPath entryType status submittedAt dutyApproval')
    .lean();
  if (!doc) throw new AppError(404, 'NOT_FOUND', 'Jadwal not found');
  const owner = await User.findById(doc.userId).select('role').lean();
  if (!owner) throw new AppError(404, 'NOT_FOUND', 'Jadwal not found');
  assertDutyApprover(caller, owner);
  if (doc.entryType !== 'mashwara_full') {
    throw new AppError(
      409,
      'CONFLICT',
      'Only a full-day mashwara needs an official-duty decision',
      {
        reason: 'NOT_MASHWARA',
      },
    );
  }
  if (doc.status !== 'submitted') {
    throw new AppError(409, 'CONFLICT', 'Only a submitted jadwal can be decided', {
      reason: 'NOT_SUBMITTED',
    });
  }

  const status: DutyDecision = body.decision === 'approve' ? 'approved' : 'rejected';
  const reason = body.reason?.trim() || undefined;
  const decision = {
    status,
    by: new Types.ObjectId(caller.id),
    byAjeerCode: caller.ajeerCode,
    at: new Date(),
    ...(reason ? { reason } : {}),
  };
  // Only on the very submission that was read: still submitted, same submittedAt (a reopen or a
  // reopen + re-submit in between wins, and the caller must load it again).
  const done = await Jadwal.updateOne(
    {
      _id: doc._id,
      status: 'submitted',
      entryType: 'mashwara_full',
      submittedAt: doc.submittedAt,
    },
    { $set: { dutyApproval: decision } },
  );
  if (done.matchedCount === 0) {
    throw new AppError(409, 'CONFLICT', 'The jadwal changed meanwhile — load it again');
  }
  await audit({
    action: status === 'approved' ? 'MASHWARA_DUTY_APPROVE' : 'MASHWARA_DUTY_REJECT',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'jadwal',
    targetId: String(doc._id),
    unitPath: doc.unitPath,
    details: {
      date: doc.date,
      ajeerCode: doc.ajeerCode,
      previous: doc.dutyApproval?.status ?? null,
      ...(reason ? { reason } : {}),
    },
  });
  return { status, byAjeerCode: caller.ajeerCode, at: decision.at, reason: reason ?? null };
}
