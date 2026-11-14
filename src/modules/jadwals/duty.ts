// Official-duty approval of a full-day mashwara (CTO 6 Nov 2026).
// A submitted full-day mashwara is Submission only until the Admin (CTO 14 Nov 2026; before that
// the owner's level directly above) explicitly approves it as official duty; only then is it Field
// Activity. Rejected or undecided
// stays Submission only; a draft counts in neither. History is never approved automatically.
// This is its own rule: a mobile-verification permission grants nothing here.
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { scopeFilter } from '../../lib/scope.js';
import { Jadwal, type DutyDecision } from '../../models/jadwal.js';
import { type Role, User } from '../../models/user.js';

/**
 * Who decides official duty for a mashwara, by the owner's role — an explicit map, never the role
 * rank (approved matrix, CTO 9 Nov 2026):
 *   zimmedar (Ushar) ← District · district ← Division · division ← Suba (in scope).
 *   tehsil: no approved duty workflow → 403 (none is inferred).
 *   suba / pakistan owners: no approver in Demo v1 → 403.
 * Never self, never any other level (a Tehsil never approves: not one of the approvers).
 */
// CTO 14 Nov 2026: the Admin decides every official duty (supervisors only view).
export const DUTY_APPROVER: Partial<Record<Role, Role>> = {
  zimmedar: 'admin',
  district: 'admin',
  division: 'admin',
};
export function assertDutyApprover(caller: AuthUser, owner: { _id: unknown; role: Role }): void {
  if (String(owner._id) === caller.id) {
    throw new AppError(403, 'FORBIDDEN', 'Nobody approves their own mashwara');
  }
  const approver = DUTY_APPROVER[owner.role];
  if (!approver) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'No official-duty approver is authorized for this level in Demo v1',
    );
  }
  if (caller.role !== approver) {
    throw new AppError(403, 'FORBIDDEN', 'Only the Admin approves official duty');
  }
}

export interface DutyView {
  status: DutyDecision;
  byAjeerCode: string;
  at: Date;
  reason: string | null;
}

/** Minimum length of the reason that changing an existing decision requires (like reopen). */
export const CHANGE_REASON_MIN = 5;

/**
 * POST /jadwals/:id/duty-approval — approve or reject a submitted full-day mashwara as official
 * duty. Audit MASHWARA_DUTY_APPROVE / _REJECT with the full previous decision, so the audit log
 * keeps every decision ever made. Changing an existing decision needs a reason (CTO 6 Nov 2026);
 * repeating the current one changes nothing.
 */
export async function decideDuty(
  caller: AuthUser,
  id: string,
  body: {
    decision: 'approve' | 'reject';
    expected: DutyDecision | null;
    reason?: string | undefined;
  },
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
  const previous = doc.dutyApproval ?? null;
  // The caller decides on what it saw: if the current decision is another one (someone decided
  // meanwhile), nothing is written — the screen reloads and the person decides again.
  if ((previous?.status ?? null) !== body.expected) {
    throw new AppError(409, 'CONFLICT', 'The decision changed meanwhile — load it again', {
      reason: 'DECISION_CHANGED',
      current: previous?.status ?? null,
    });
  }
  if (previous?.status === status) {
    return {
      status,
      byAjeerCode: previous.byAjeerCode,
      at: previous.at,
      reason: previous.reason ?? null,
    };
  }
  if (previous && (reason?.length ?? 0) < CHANGE_REASON_MIN) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Changing a decision needs a reason', {
      field: 'reason',
      reason: 'REASON_REQUIRED',
    });
  }
  const decision = {
    status,
    by: new Types.ObjectId(caller.id),
    byAjeerCode: caller.ajeerCode,
    at: new Date(),
    ...(reason ? { reason } : {}),
  };
  // Only on the very submission and decision that were read: still submitted, same submittedAt,
  // same current decision (a reopen, a re-submit or another decision in between wins, and the
  // caller must load it again — so no change ever skips the reason rule).
  const done = await Jadwal.updateOne(
    {
      _id: doc._id,
      status: 'submitted',
      entryType: 'mashwara_full',
      submittedAt: doc.submittedAt,
      ...(previous
        ? { 'dutyApproval.status': previous.status, 'dutyApproval.at': previous.at }
        : { dutyApproval: { $exists: false } }),
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
      previous: previous?.status ?? null,
      // The decision this one replaces, in full (the audit log is the complete history).
      previousDecision: previous
        ? {
            status: previous.status,
            byAjeerCode: previous.byAjeerCode,
            at: previous.at,
            reason: previous.reason ?? null,
          }
        : null,
      ...(reason ? { reason } : {}),
    },
  });
  return { status, byAjeerCode: caller.ajeerCode, at: decision.at, reason: reason ?? null };
}
