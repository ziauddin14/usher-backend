import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

export const RESET_REQUEST_STATUS = ['pending', 'done'] as const;

/**
 * "پاس ورڈ بھول گئے؟" — a user (ajeer code + registered mobile) asks for a reset; it shows on the
 * dashboard of the supervisors above them (their District first) until someone resets the password.
 */
const passwordResetRequestSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ajeerCode: { type: String, required: true },
    name: { type: String, required: true },
    nameUr: { type: String },
    role: { type: String, required: true },
    unitCode: { type: String, required: true },
    unitPath: { type: String, required: true },
    status: { type: String, enum: RESET_REQUEST_STATUS, required: true, default: 'pending' },
    requestedAt: { type: Date, required: true },
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

passwordResetRequestSchema.index({ unitPath: 1, status: 1 });
// At most one open request per user.
passwordResetRequestSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

export type PasswordResetRequestDoc = InferSchemaType<typeof passwordResetRequestSchema>;

export const PasswordResetRequest: Model<PasswordResetRequestDoc> =
  (mongoose.models.PasswordResetRequest as Model<PasswordResetRequestDoc> | undefined) ??
  mongoose.model('PasswordResetRequest', passwordResetRequestSchema, 'passwordResetRequests');
