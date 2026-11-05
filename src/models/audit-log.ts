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
  'MOBILE_SELF_REGISTER',
  'MOBILE_CONFIRM',
  'MOBILE_REJECT',
  'USER_STATUS',
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
