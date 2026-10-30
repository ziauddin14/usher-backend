import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

export const ENTRY_TYPES = ['amli', 'rukhsat', 'course', 'qafila', 'mashwara_full'] as const;
export const JADWAL_STATUS = ['draft', 'submitted'] as const;
export const VISIT_STEPS = ['donors', 'atiyat', 'ijtima', 'mashwara'] as const;

const money = { type: Number, min: 0, validate: Number.isInteger };
const count = { type: Number, min: 0, validate: Number.isInteger };

const visitSchema = new Schema({
  villageId: { type: Schema.Types.ObjectId, ref: 'Village', required: true },
  villageName: { type: String, required: true },
  donors: {
    type: new Schema(
      {
        oldMet: { ...count, default: 0 },
        newDonors: [
          new Schema(
            {
              name: { type: String, required: true },
              mobile: { type: String, match: /^03\d{9}$/ },
              acres: { type: Number, min: 0 },
            },
            { _id: false },
          ),
        ],
      },
      { _id: false },
    ),
  },
  atiyat: {
    type: new Schema(
      {
        entries: [
          new Schema(
            {
              type: { type: String, enum: ['niyyat', 'wusooli'], required: true },
              category: { type: String, required: true },
              kind: { type: String, enum: ['naqd', 'jins'], required: true },
              amount: { ...money, required: true },
              detail: { type: String },
            },
            { _id: false },
          ),
        ],
        gsb: { type: new Schema({ boxesOpened: count, amount: money }, { _id: false }) },
      },
      { _id: false },
    ),
  },
  ijtima: {
    type: new Schema(
      {
        held: { type: Boolean, required: true },
        type: { type: String, enum: ['kisan', 'zamindar'] },
        participants: count,
      },
      { _id: false },
    ),
  },
  mashwara: {
    type: new Schema(
      {
        held: { type: Boolean, required: true },
        participants: count,
        note: { type: String, maxlength: 300 },
      },
      { _id: false },
    ),
  },
  savedSteps: [{ type: String, enum: VISIT_STEPS }],
});

const totalsSchema = new Schema(
  {
    villages: count,
    oldDonors: count,
    newDonors: count,
    niyyat: money,
    wusooli: money,
    rewardWusooli: money,
    excludedWusooli: money,
    gsbBoxes: count,
    gsbAmount: money,
    ijtimas: count,
    ijtimaParticipants: count,
    mashwaras: count,
    km: count,
    fare: money,
  },
  { _id: false },
);

const jadwalSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ajeerCode: { type: String, required: true },
    unitPath: { type: String, required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    entryType: { type: String, enum: ENTRY_TYPES, required: true },
    status: { type: String, enum: JADWAL_STATUS, required: true, default: 'draft' },
    startedAt: { type: Date, required: true },
    submittedAt: { type: Date },
    travel: {
      type: new Schema(
        {
          mode: { type: String, enum: ['bike', 'bus'], required: true },
          meterStart: count,
          meterEnd: count,
          km: count,
          fare: money,
        },
        { _id: false },
      ),
    },
    note: { type: String, maxlength: 500 },
    visits: [visitSchema],
    totals: { type: totalsSchema },
    reopened: [
      new Schema(
        {
          by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          at: { type: Date, required: true },
          reason: { type: String, required: true },
        },
        { _id: false },
      ),
    ],
  },
  { timestamps: true },
);

jadwalSchema.index({ userId: 1, date: 1 }, { unique: true });
jadwalSchema.index({ unitPath: 1, date: 1, status: 1 });
jadwalSchema.index({ unitPath: 1, month: 1, status: 1 });

export type JadwalDoc = InferSchemaType<typeof jadwalSchema>;

export const Jadwal: Model<JadwalDoc> =
  (mongoose.models.Jadwal as Model<JadwalDoc> | undefined) ??
  mongoose.model('Jadwal', jadwalSchema, 'jadwals');
