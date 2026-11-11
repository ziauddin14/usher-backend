import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

/**
 * One line of an E-Raseed (ERP) receipt, from the daily file the Pakistan level uploads
 * (CTO 11 Nov 2026). The ERP is the source of truth for the details (mad, material); the
 * zimmedar's own jadwal keeps only his day's total. A receipt line is identified by
 * (receiptNo, lineNo): uploading the same file again changes nothing, and a later file may mark a
 * line cancelled — lines are never deleted.
 */
const erpReceiptSchema = new Schema(
  {
    receiptNo: { type: String, required: true },
    lineNo: { type: Number, required: true, default: 1, min: 1 },
    /** Receipt date (Asia/Karachi calendar day) as YYYY-MM-DD. */
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    /** The zimmedar the receipt belongs to (login code, part before "/"). */
    ajeerCode: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** The zimmedar's unit when the line was uploaded — the scope of every report. */
    unitPath: { type: String, required: true },
    /** Gaon name as the ERP writes it; villageId when it matched a Gaon of the zimmedar's District. */
    villageName: { type: String },
    villageId: { type: Schema.Types.ObjectId, ref: 'Village' },
    kind: { type: String, enum: ['naqd', 'jins'], required: true },
    /** Integer rupees (for jins: the value the ERP records). */
    amount: { type: Number, required: true, min: 0, validate: Number.isInteger },
    /** Mad / head as the ERP names it (not mapped to the app's atiyat categories). */
    mad: { type: String },
    item: { type: String },
    qty: { type: Number, min: 0 },
    qtyUnit: { type: String },
    cancelled: { type: Boolean, required: true, default: false },
    /** E-Raseed "Fund Category" (Wajiba / Nafila / Defined Purpose), when given. */
    fund: { type: String },
    /** E-Raseed "Deposit / Undeposit" (cash only): true = DEPOSITED, false = UNDEPOSIT. */
    deposited: { type: Boolean },
    /** The upload that last wrote this line. */
    uploadId: { type: Schema.Types.ObjectId, ref: 'ErpUpload', required: true },
  },
  { timestamps: true },
);

erpReceiptSchema.index({ receiptNo: 1, lineNo: 1 }, { unique: true });
erpReceiptSchema.index({ unitPath: 1, date: 1 });
erpReceiptSchema.index({ userId: 1, date: 1 });

export type ErpReceiptDoc = InferSchemaType<typeof erpReceiptSchema>;

export const ErpReceipt: Model<ErpReceiptDoc> =
  (mongoose.models.ErpReceipt as Model<ErpReceiptDoc> | undefined) ??
  mongoose.model('ErpReceipt', erpReceiptSchema, 'erpReceipts');

/** One confirmed upload of the daily E-Raseed file (counts only — no receipt details). */
const erpUploadSchema = new Schema(
  {
    fileName: { type: String, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    byAjeerCode: { type: String, required: true },
    at: { type: Date, required: true },
    rows: { type: Number, required: true },
    added: { type: Number, required: true },
    updated: { type: Number, required: true },
    unchanged: { type: Number, required: true },
    rejected: { type: Number, required: true },
    dateFrom: { type: String },
    dateTo: { type: String },
  },
  { timestamps: true },
);

erpUploadSchema.index({ at: -1 });

export type ErpUploadDoc = InferSchemaType<typeof erpUploadSchema>;

export const ErpUpload: Model<ErpUploadDoc> =
  (mongoose.models.ErpUpload as Model<ErpUploadDoc> | undefined) ??
  mongoose.model('ErpUpload', erpUploadSchema, 'erpUploads');
