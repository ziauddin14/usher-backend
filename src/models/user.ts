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
 * Explicit, designated permissions (CTO 5 Nov 2026) — never implied by the role.
 * VERIFY_SUBA_MOBILE: a pakistan-level account designated to verify suba accounts' self-entered
 * mobiles ("designated Pakistan Admin"). Set only with scripts/designate-verifier.ts (audited).
 */
export const PERMISSIONS = ['VERIFY_SUBA_MOBILE'] as const;
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
    /** false = typed by the user at the first login, waiting for the District to confirm ("tasdeeq baqi"). */
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
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

userSchema.index({ unitPath: 1, role: 1 });

export type UserDoc = InferSchemaType<typeof userSchema>;

export const User: Model<UserDoc> =
  (mongoose.models.User as Model<UserDoc> | undefined) ??
  mongoose.model('User', userSchema, 'users');
