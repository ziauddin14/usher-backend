import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

export const VILLAGE_STATUS = ['approved', 'pending', 'merged'] as const;
export const VILLAGE_SOURCES = ['import', 'zimmedar', 'district'] as const;

const villageSchema = new Schema(
  {
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    districtCode: { type: String, required: true },
    unitPath: { type: String, required: true },
    tehsil: { type: String },
    status: { type: String, enum: VILLAGE_STATUS, required: true, default: 'pending' },
    mergedInto: { type: Schema.Types.ObjectId, ref: 'Village' },
    /** The Ushar Zimmedar responsible for this village (from the village list import, or the adder). */
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    /** The Gaon's local zimmedar (name, mobile) from Shoba Ushar's donor list (CTO 12 Nov 2026). */
    localZimmedar: {
      type: new Schema({ name: { type: String }, mobile: { type: String } }, { _id: false }),
    },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    /** Where the record came from: the official list import, a zimmedar, or the District. */
    source: {
      type: new Schema(
        {
          kind: { type: String, enum: VILLAGE_SOURCES, required: true },
          /** Import file name (no folder) and its row, for an imported village. */
          file: { type: String },
          row: { type: Number },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
    },
    /**
     * Earlier spellings: renames, and names of duplicates merged into this one. A later import of
     * the official list matches them, so a corrected or merged village never comes back twice.
     */
    formerNames: {
      type: [
        new Schema(
          {
            name: { type: String, required: true },
            nameKey: { type: String, required: true },
            at: { type: Date, required: true },
            reason: { type: String, enum: ['rename', 'merge'], required: true },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
  },
  { timestamps: true },
);

// One live village per normalized name per district (merged ones are history).
villageSchema.index(
  { unitPath: 1, nameKey: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['approved', 'pending'] } } },
);
villageSchema.index({ addedBy: 1, status: 1 });
villageSchema.index({ assignedTo: 1, status: 1 });
villageSchema.index({ unitPath: 1, 'formerNames.nameKey': 1 });

export type VillageDoc = InferSchemaType<typeof villageSchema>;

export const Village: Model<VillageDoc> =
  (mongoose.models.Village as Model<VillageDoc> | undefined) ??
  mongoose.model('Village', villageSchema, 'villages');
