import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

export const ROLES = ['zimmedar', 'district', 'division', 'suba', 'pakistan'] as const;
export type Role = (typeof ROLES)[number];

/** Higher number = higher level in the hierarchy. */
export const ROLE_RANK: Record<Role, number> = {
  zimmedar: 0,
  district: 1,
  division: 2,
  suba: 3,
  pakistan: 4,
};

export const ZIMMEDARI = ['ushar', 'tehsil_town', 'event'] as const;

/**
 * Explicit, designated permissions (CTO decisions of 5–6 Nov 2026) — never implied by a role or a
 * department. Set only with scripts/designate-verifier.ts (audited USER_PERMISSION).
 * - VERIFY_SUBA_MOBILE: a pakistan-level account designated to verify suba accounts' self-entered
 *   mobiles ("designated Pakistan Admin").
 * - VERIFY_PAKISTAN_MOBILE: the designated Central IT verifier — a pakistan-level account of the
 *   Central IT Department — verifies pakistan-level accounts' self-entered mobiles.
 */
export const PERMISSIONS = ['VERIFY_SUBA_MOBILE', 'VERIFY_PAKISTAN_MOBILE'] as const;

/**
 * Department of a centrally provisioned account (CTO 6 Nov 2026). Set only by the controlled
 * provisioning command (scripts/provision-pakistan-admin.ts, audited USER_PROVISION); never by an
 * import. Membership alone grants nothing.
 */
export const DEPARTMENTS = ['CENTRAL_IT'] as const;
export type Department = (typeof DEPARTMENTS)[number];
export type Permission = (typeof PERMISSIONS)[number];
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
    /** Registered mobile, normalized 03XXXXXXXXX — checked on first login and forgot-password. */
    mobile: { type: String, match: /^03\d{9}$/ },
    /**
     * A later change of the registered mobile, asked for by the user (CTO 7 Nov 2026). The current
     * number keeps working until the user's verifier (the same hierarchy as a first-login number)
     * confirms the new one; reject or cancel removes it. Imports never touch it.
     */
    mobileChange: {
      type: new Schema(
        {
          mobile: { type: String, required: true, match: /^03\d{9}$/ },
          requestedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
    },
    /** Last HR import that touched this account: file name (no folder), row and time. */
    hrImport: {
      type: new Schema(
        { file: { type: String }, row: { type: Number }, at: { type: Date, required: true } },
        { _id: false },
      ),
    },
    /** false = typed by the user at the first login, waiting for its verifier to confirm ("tasdeeq baqi"). */
    mobileVerified: { type: Boolean },
    role: { type: String, enum: ROLES, required: true },
    zimmedari: { type: String, enum: ZIMMEDARI },
    unitCode: { type: String, required: true },
    unitPath: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    mustChangePassword: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
    /**
     * Bumped on a supervisor password reset (and a rejected mobile): every session token signed with
     * an older version stops working, so all logged-in devices must log in again.
     */
    sessionVersion: { type: Number, default: 0 },
    /** Designated permissions (see PERMISSIONS); empty for almost everybody. */
    permissions: { type: [{ type: String, enum: PERMISSIONS }], default: [] },
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
  },
  { timestamps: true },
);

userSchema.index({ unitPath: 1, role: 1 });

export type UserDoc = InferSchemaType<typeof userSchema>;

/**
 * A pakistan-level or centrally provisioned account (CTO 6 Nov 2026): only Central IT's controlled
 * process creates or changes it, and only the designated Central IT verifier verifies its mobile.
 * No import (employees, mobiles) ever touches one.
 */
export function isCentrallyManaged(u: {
  role?: string | null;
  department?: string | null;
  provisioned?: unknown;
}): boolean {
  return u.role === 'pakistan' || Boolean(u.department) || Boolean(u.provisioned);
}

/**
 * Mongo filter for "not centrally managed" — the same rule as isCentrallyManaged. `{ $not: { $ne: null } }`
 * matches a missing field and a stored null alike, and is never copied into a document an upsert
 * inserts (a one-element `$in` or `{ field: null }` would be).
 */
export const NOT_CENTRALLY_MANAGED = {
  role: { $ne: 'pakistan' },
  department: { $not: { $ne: null } },
  provisioned: { $not: { $ne: null } },
} as const;

export const User: Model<UserDoc> =
  (mongoose.models.User as Model<UserDoc> | undefined) ??
  mongoose.model('User', userSchema, 'users');
