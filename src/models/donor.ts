import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

/**
 * A donor of a Gaon (CTO 12 Nov 2026). Imported from Shoba Ushar's donor list, or added by a
 * zimmedar as a new donor (saved when the day is submitted; from the next day on it is in the
 * Gaon's list of old donors, marked "new" until a later meeting). A donor belongs to the Gaon:
 * whoever has the Gaon assigned sees its donors.
 */
const donorSchema = new Schema(
  {
    villageId: { type: Schema.Types.ObjectId, ref: 'Village', required: true },
    /** The Gaon's unit path (its District) — the scope of every query. */
    unitPath: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    /** 03XXXXXXXXX when known. */
    mobile: { type: String, match: /^03\d{9}$/ },
    acres: { type: Number, min: 0 },
    /** Karachi date from which the donor counts as an old donor of the Gaon. */
    addedOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    source: {
      type: new Schema(
        {
          kind: { type: String, enum: ['import', 'zimmedar'], required: true },
          file: { type: String },
          row: { type: Number },
          jadwalId: { type: Schema.Types.ObjectId, ref: 'Jadwal' },
          byUserId: { type: Schema.Types.ObjectId, ref: 'User' },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    /** Meetings recorded in submitted jadwals after the donor was added. */
    meetings: { type: Number, required: true, default: 0, min: 0 },
    /** The latest meeting: its date, jadwal and the tasks done. */
    lastMet: {
      type: new Schema(
        {
          date: { type: String, required: true },
          jadwalId: { type: Schema.Types.ObjectId, ref: 'Jadwal', required: true },
          tasks: {
            type: [
              new Schema(
                { id: { type: String, required: true }, count: Number, parts: [String] },
                { _id: false },
              ),
            ],
            default: undefined,
          },
        },
        { _id: false },
      ),
    },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

// One donor per mobile per Gaon; without a mobile, one per name per Gaon.
donorSchema.index(
  { villageId: 1, mobile: 1 },
  { unique: true, partialFilterExpression: { mobile: { $type: 'string' } } },
);
donorSchema.index({ villageId: 1, nameKey: 1 });
donorSchema.index({ unitPath: 1 });

export type DonorDoc = InferSchemaType<typeof donorSchema>;

export const Donor: Model<DonorDoc> =
  (mongoose.models.Donor as Model<DonorDoc> | undefined) ??
  mongoose.model('Donor', donorSchema, 'donors');
