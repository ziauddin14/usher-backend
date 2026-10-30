import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

const categorySchema = new Schema(
  {
    id: { type: String, required: true },
    labelUr: { type: String, required: true },
    labelRoman: { type: String, required: true },
    rewardIncluded: { type: Boolean, required: true },
    order: { type: Number, required: true },
  },
  { _id: false },
);

/** Single document `_id: 'app'` — every configurable rule (data model `settings`). */
const settingSchema = new Schema(
  {
    _id: { type: String, required: true },
    backdateDays: { type: Number, required: true },
    maxKmPerDay: { type: Number, required: true },
    weekStartsOn: { type: Number, required: true },
    atiyatCategories: { type: [categorySchema], required: true },
    reward: {
      periods: [
        new Schema(
          {
            id: { type: String, required: true },
            startMonth: { type: Number, required: true },
            months: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      divisor: { type: Number, required: true },
      tiers: [
        new Schema(
          { minAvg: { type: Number, required: true }, amount: { type: Number, required: true } },
          { _id: false },
        ),
      ],
      nearPct: { type: Number, required: true },
    },
    targets: {
      newDonorsPerOutdoorDay: { type: Number, required: true },
      ijtimaPerMonth: { type: Number, required: true },
      mashwaraPerMonth: { type: Number, required: true },
    },
  },
  { timestamps: true },
);

export type SettingDoc = InferSchemaType<typeof settingSchema>;

export const Setting: Model<SettingDoc> =
  (mongoose.models.Setting as Model<SettingDoc> | undefined) ??
  mongoose.model('Setting', settingSchema, 'settings');
