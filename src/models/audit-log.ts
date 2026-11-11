import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

export const AUDIT_ACTIONS = [
  'LOGIN',
  'LOGIN_FAILED',
  'JADWAL_SUBMIT',
  'JADWAL_REOPEN',
  'VILLAGE_ADD',
  'VILLAGE_APPROVE',
  'VILLAGE_MERGE',
  'VILLAGE_REASSIGN',
  'PASSWORD_RESET',
  'PASSWORD_RESET_REQUEST',
  'PASSWORD_CHANGE',
  'USER_PROVISION',
  'MASHWARA_DUTY_APPROVE',
  'MASHWARA_DUTY_REJECT',
  'USER_STATUS',
  'IMPORT_EMPLOYEES',
  'IMPORT_VILLAGES',
  'VILLAGE_CREATE',
  'VILLAGE_RENAME',
  // Own mobile set, changed or removed by the user (no verification, CTO 7 Nov 2026).
  'MOBILE_UPDATE',
  // Daily E-Raseed (ERP) receipts file uploaded at Pakistan level (CTO 11 Nov 2026).
  'ERP_UPLOAD',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const auditLogSchema = new Schema(
  {
    at: { type: Date, required: true, default: () => new Date() },
    // Unknown for LOGIN_FAILED with an ajeer code that does not exist.
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorAjeerCode: { type: String, required: true },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    targetType: { type: String },
    targetId: { type: String },
    unitPath: { type: String },
    details: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

auditLogSchema.index({ at: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;

export const AuditLog: Model<AuditLogDoc> =
  (mongoose.models.AuditLog as Model<AuditLogDoc> | undefined) ??
  mongoose.model('AuditLog', auditLogSchema, 'auditLogs');
