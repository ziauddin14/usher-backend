import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

export const VILLAGE_STATUS = ['approved', 'pending', 'merged'] as const;

const villageSchema = new Schema(
  {
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    districtCode: { type: String, required: true },
    unitPath: { type: String, required: true },
    tehsil: { type: String },
    status: { type: String, enum: VILLAGE_STATUS, required: true, default: 'pending' },
    mergedInto: { type: Schema.Types.ObjectId, ref: 'Village' },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
  },
  { timestamps: true },
);

// One live village per normalized name per district (merged ones are history).
villageSchema.index(
  { unitPath: 1, nameKey: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['approved', 'pending'] } } },
);
villageSchema.index({ addedBy: 1, status: 1 });

export type VillageDoc = InferSchemaType<typeof villageSchema>;

export const Village: Model<VillageDoc> =
  (mongoose.models.Village as Model<VillageDoc> | undefined) ??
  mongoose.model('Village', villageSchema, 'villages');
