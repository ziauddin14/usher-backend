import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

// 'tehsil' stays only for old records (no Tehsil level since CTO 13 Nov 2026). 'admin' (CTO 14 Nov
// 2026): the Pakistan-level Admin who alone changes data; every other dashboard role only views.
export const ROLES = ['zimmedar', 'tehsil', 'district', 'division', 'suba', 'pakistan', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Higher number = higher level in the hierarchy (Pakistan → Suba → Division → District → Tehsil →
 * Ushar Zimmedar). Only for "below me" listings — approvals and management use explicit rules
 * (jadwals/duty.ts DUTY_APPROVER, auth.ts EDITOR_ROLES), never the rank alone.
 */
export const ROLE_RANK: Record<Role, number> = {
  zimmedar: 0,
  tehsil: 1,
  district: 2,
  division: 3,
  suba: 4,
  pakistan: 5,
  admin: 6,
};

export const ZIMMEDARI = ['ushar', 'tehsil_town', 'event'] as const;

/**
 * Department of a centrally provisioned account (CTO 6 Nov 2026). Set only by the controlled
 * provisioning command (scripts/provision-pakistan-admin.ts, audited USER_PROVISION); never by an
 * import. A record of where the account belongs — it grants nothing.
 */
export const DEPARTMENTS = ['CENTRAL_IT'] as const;
export type Department = (typeof DEPARTMENTS)[number];
export type Zimmedari = (typeof ZIMMEDARI)[number];

const userSchema = new Schema(
  {
    ajeerCode: { type: String, required: true, unique: true, match: /^\d+$/ },
    /** The code as written in the employee list, e.g. "12345/1" (login uses ajeerCode "12345"). */
    ajeerCodeFull: { type: String },
    name: { type: String, required: true },
    nameUr: { type: String },
    /** Walid (father's name) from the employee list. */
    fatherName: { type: String },
    /**
     * Optional profile mobile, normalized 03XXXXXXXXX. No verification (CTO 7 Nov 2026): the user
     * sets or changes it themselves; never needed to log in. A forgot-password request matches it.
     */
    mobile: { type: String, match: /^03\d{9}$/ },
    /** Last HR import that touched this account: file name (no folder), row and time. */
    hrImport: {
      type: new Schema(
        { file: { type: String }, row: { type: Number }, at: { type: Date, required: true } },
        { _id: false },
      ),
    },
    role: { type: String, enum: ROLES, required: true },
    zimmedari: { type: String, enum: ZIMMEDARI },
    unitCode: { type: String, required: true },
    unitPath: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    mustChangePassword: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
    /**
     * Bumped on a supervisor password reset or a deactivation: every session token signed with
     * an older version stops working, so all logged-in devices must log in again.
     */
    sessionVersion: { type: Number, default: 0 },
    /** Only on centrally provisioned accounts (see DEPARTMENTS). */
    department: { type: String, enum: DEPARTMENTS },
    /**
     * How a centrally provisioned (pakistan-level) account came to exist: the nomination and its
     * administrative confirmation (document references), who provisioned it and when.
     */
    provisioned: {
      type: new Schema(
        {
          nominationRef: { type: String, required: true },
          approvalRef: { type: String, required: true },
          operator: { type: String, required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
    },
    isDemo: { type: Boolean, default: false },
    /**
     * Test-mode zimmedar (CTO 13 Nov 2026): lives in the TEST sandbox unit (outside PK, so no report,
     * dashboard, ERP or import ever counts him); his old test data is cleared at every login.
     */
    isTest: { type: Boolean, default: false },
  },
  { timestamps: true },
);

userSchema.index({ unitPath: 1, role: 1 });

export type UserDoc = InferSchemaType<typeof userSchema>;

/**
 * A pakistan-level or centrally provisioned account (CTO 6 Nov 2026): only Central IT's controlled
 * process creates or changes it.
 * No import (employees, mobiles) ever touches one.
 */
export function isCentrallyManaged(u: {
  role?: string | null;
  department?: string | null;
  provisioned?: unknown;
}): boolean {
  return (
    u.role === 'pakistan' || u.role === 'admin' || Boolean(u.department) || Boolean(u.provisioned)
  );
}

/**
 * Mongo filter for "not centrally managed" — the same rule as isCentrallyManaged. `{ $not: { $ne: null } }`
 * matches a missing field and a stored null alike, and is never copied into a document an upsert
 * inserts (a one-element `$in` or `{ field: null }` would be).
 */
export const NOT_CENTRALLY_MANAGED = {
  role: { $nin: ['pakistan', 'admin'] },
  department: { $not: { $ne: null } },
  provisioned: { $not: { $ne: null } },
} as const;

export const User: Model<UserDoc> =
  (mongoose.models.User as Model<UserDoc> | undefined) ??
  mongoose.model('User', userSchema, 'users');
