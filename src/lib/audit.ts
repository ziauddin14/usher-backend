import { AuditLog, type AuditAction } from '../models/audit-log.js';

interface AuditEntry {
  action: AuditAction;
  actorId?: string;
  actorAjeerCode: string;
  targetType?: string;
  targetId?: string;
  unitPath?: string;
  details?: Record<string, unknown>;
}

/** Append one audit log document. Never put passwords or tokens in `details`. */
export async function audit(entry: AuditEntry): Promise<void> {
  await AuditLog.create({ at: new Date(), ...entry });
}
