import mongoose, { type InferSchemaType, type Model, Schema } from 'mongoose';

/** rejected: a new Gaon added by mistake, refused by the Admin (CTO 28 Nov 2026); never deleted. */
export const VILLAGE_STATUS = ['approved', 'pending', 'merged', 'rejected'] as const;
export const VILLAGE_SOURCES = ['import', 'zimmedar', 'district'] as const;
/**
 * Why a Gaon from the official list sits in the District pool (CTO 13 Nov 2026): the District sees
 * it next to the Gaon with the way to fix it.
 *  - ZIMMEDAR_NOT_FOUND: the file's Ajeer Code is no zimmedar account (unknown, not an Ajeer Code,
 *    none given) → assign a zimmedar.
 *  - NOT_IMPORTED_EMPLOYEE: the HR import rejected that employee → assign a zimmedar.
 *  - SUPERVISOR_CODE: listed under a District / Division account → assign a zimmedar.
 *  - DISTRICT_MISMATCH: the file's District is not the zimmedar's District → keep here and assign,
 *    or ask HR / the Gaon list to correct the District.
 *  - SIMILAR_NAME: a Gaon with almost the same name already exists here → merge into it, or keep
 *    (correct the spelling).
 */
export const VILLAGE_ISSUES = [
  'ZIMMEDAR_NOT_FOUND',
  'NOT_IMPORTED_EMPLOYEE',
  'SUPERVISOR_CODE',
  'DISTRICT_MISMATCH',
  'SIMILAR_NAME',
] as const;
export type VillageIssueKind = (typeof VILLAGE_ISSUES)[number];

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
    /** Open problems of a pool Gaon (see VILLAGE_ISSUES); cleared as the District fixes them. */
    issues: {
      type: [
        new Schema(
          {
            kind: { type: String, enum: VILLAGE_ISSUES, required: true },
            detail: { type: String },
            /** SIMILAR_NAME: the existing Gaon to merge into. */
            suggestionId: { type: Schema.Types.ObjectId, ref: 'Village' },
            suggestionName: { type: String },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    /**
     * The Gaon's local zimmedar (name, mobile) from Shoba Ushar's donor list (CTO 12 Nov 2026); a
     * permanent person of the Gaon. Since CTO 17 Nov 2026 also filled in on the screens.
     */
    localZimmedar: {
      type: new Schema({ name: { type: String }, mobile: { type: String } }, { _id: false }),
    },
    /**
     * Where the Gaon is (CTO 17 Nov 2026): the phone's GPS when a zimmedar adds the Gaon or presses
     * the button in it, or a point the Admin marks (Google Maps link / coordinates).
     */
    location: {
      type: new Schema(
        {
          lat: { type: Number, required: true },
          lng: { type: Number, required: true },
          /** GPS accuracy in metres, when the phone gives it. */
          accuracy: { type: Number },
          source: { type: String, enum: ['gps', 'admin'], required: true },
          by: { type: Schema.Types.ObjectId, ref: 'User' },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
    },
    /** Crops grown in the Gaon: ids of settings.crops (CTO 17 Nov 2026). */
    crops: { type: [String], default: undefined },
    /** The name of an "other" crop (crops contains 'other'). */
    cropsOther: { type: String },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: { type: Date },
    rejectReason: { type: String, maxlength: 300 },
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
