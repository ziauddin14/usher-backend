import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

export const UNIT_LEVELS = ['pakistan', 'suba', 'division', 'district'] as const;
export type UnitLevel = (typeof UNIT_LEVELS)[number];

const unitSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    nameUr: { type: String },
    level: { type: String, enum: UNIT_LEVELS, required: true },
    parentCode: { type: String, default: null },
    path: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

unitSchema.index({ path: 1 }, { unique: true });
unitSchema.index({ parentCode: 1 });

export type UnitDoc = InferSchemaType<typeof unitSchema>;

export const Unit: Model<UnitDoc> =
  (mongoose.models.Unit as Model<UnitDoc> | undefined) ??
  mongoose.model('Unit', unitSchema, 'units');
