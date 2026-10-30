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
export type Zimmedari = (typeof ZIMMEDARI)[number];

const userSchema = new Schema(
  {
    ajeerCode: { type: String, required: true, unique: true, match: /^\d+$/ },
    name: { type: String, required: true },
    nameUr: { type: String },
    role: { type: String, enum: ROLES, required: true },
    zimmedari: { type: String, enum: ZIMMEDARI },
    unitCode: { type: String, required: true },
    unitPath: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    mustChangePassword: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

userSchema.index({ unitPath: 1, role: 1 });

export type UserDoc = InferSchemaType<typeof userSchema>;

export const User: Model<UserDoc> =
  (mongoose.models.User as Model<UserDoc> | undefined) ??
  mongoose.model('User', userSchema, 'users');
