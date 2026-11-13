import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

/**
 * A niyyat (pledge) of a donor (CTO 13 Nov 2026): what a donor said he will give, and by which
 * month, so the zimmedar can follow it up. Written on the atiyat screen's niyyat tab, saved when the
 * day is submitted; closed ("وصول ہو گئی") when the zimmedar meets the donor and receives it.
 * Never deleted: a niyyat removed from a reopened day is marked cancelled.
 */
const pledgeSchema = new Schema(
  {
    donorId: { type: Schema.Types.ObjectId, ref: 'Donor', required: true },
    villageId: { type: Schema.Types.ObjectId, ref: 'Village', required: true },
    /** The Gaon's unit path (its District): the scope of every query. */
    unitPath: { type: String, required: true },
    /** The zimmedar who wrote it. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** The jadwal day it was written, and its place there (one pledge per niyyat entry). */
    jadwalId: { type: Schema.Types.ObjectId, ref: 'Jadwal', required: true },
    visitId: { type: Schema.Types.ObjectId, required: true },
    entry: { type: Number, required: true, min: 0 },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    /** عشر or عطیہ. */
    niyyatType: { type: String, enum: ['ushr', 'atiya'], required: true },
    kind: { type: String, enum: ['naqd', 'jins'], required: true },
    /** Naqd: rupees. Jins: an optional estimated value (0 when unknown). */
    amount: { type: Number, required: true, min: 0, validate: Number.isInteger },
    item: { type: String },
    qty: { type: Number, min: 0 },
    unit: { type: String },
    /** The month by which it is expected (YYYY-MM). */
    dueMonth: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    status: { type: String, enum: ['open', 'received', 'cancelled'], required: true },
    received: {
      type: new Schema(
        {
          date: { type: String, required: true },
          jadwalId: { type: Schema.Types.ObjectId, ref: 'Jadwal', required: true },
        },
        { _id: false },
      ),
    },
  },
  { timestamps: true },
);

pledgeSchema.index({ jadwalId: 1, visitId: 1, entry: 1 }, { unique: true });
pledgeSchema.index({ donorId: 1, status: 1 });
pledgeSchema.index({ unitPath: 1, status: 1, dueMonth: 1 });
pledgeSchema.index({ userId: 1, status: 1 });

export type PledgeDoc = InferSchemaType<typeof pledgeSchema>;

export const Pledge: Model<PledgeDoc> =
  (mongoose.models.Pledge as Model<PledgeDoc> | undefined) ??
  mongoose.model('Pledge', pledgeSchema, 'pledges');
