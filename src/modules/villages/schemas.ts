import { z } from 'zod';
import { VILLAGE_ISSUES } from '../../models/village.js';

export const listVillagesQuery = z.object({ q: z.string().trim().max(60).optional() });

export const villageIdParams = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });
export const approveSchema = z.object({ name: z.string().trim().min(2).max(80).optional() });
export const mergeSchema = z.object({ intoId: z.string().regex(/^[a-f0-9]{24}$/i) });
/** POST /villages/:id/reject — why a new Gaon is refused (CTO 28 Nov 2026). */
export const rejectSchema = z.object({ reason: z.string().trim().min(5).max(300) });
export const assignSchema = z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/i) });

/** A point on the map: the phone's GPS (accuracy in metres) or one the Admin marks. */
export const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).optional(),
});

export const addVillageSchema = z.object({
  name: z.string().trim().min(2, 'name is too short').max(80),
  /** The phone's location when the zimmedar adds the Gaon (CTO 17 Nov 2026), if allowed. */
  location: locationSchema.optional(),
});

/**
 * PATCH /villages/:id/info (CTO 17 Nov 2026). The zimmedar of the Gaon fills an empty field once;
 * the Admin fills and changes (null clears). Only the fields sent are touched.
 */
export const villageInfoSchema = z
  .object({
    localZimmedar: z
      .object({
        name: z.string().trim().max(100).nullable().optional(),
        mobile: z.string().trim().max(20).nullable().optional(),
      })
      .optional(),
    crops: z
      .array(z.string().regex(/^[a-z0-9_]{1,40}$/))
      .max(30)
      .nullable()
      .optional(),
    /** The name of an "other" crop; sent with crops. */
    cropsOther: z.string().trim().max(80).optional(),
    location: locationSchema.nullable().optional(),
  })
  .refine(
    (v) => v.localZimmedar !== undefined || v.crops !== undefined || v.location !== undefined,
    {
      message: 'nothing to change',
    },
  );
export type VillageInfoInput = z.infer<typeof villageInfoSchema>;

const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const villageName = z.string().trim().min(2, 'name is too short').max(80);

/** District adds a village (approved), optionally for a zimmedar. */
export const createVillageSchema = z.object({
  name: villageName,
  districtCode: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .optional(),
  assignTo: objectId.optional(),
});

/** Correct the spelling and / or the tehsil. At least one of them. */
export const updateVillageSchema = z
  .object({ name: villageName.optional(), tehsil: z.string().trim().max(80).optional() })
  .refine((v) => v.name !== undefined || v.tehsil !== undefined, { message: 'nothing to change' });

export const duplicatesQuery = z.object({
  unit: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .optional(),
});

/** GET /villages/:id/donors?date=YYYY-MM-DD — the jadwal's date (default today). */
export const donorsQuery = z.object({
  date: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
    .optional(),
});

/** POST /villages/:id/resolve-issue (CTO 13 Nov 2026). */
export const resolveIssueSchema = z.object({ kind: z.enum(VILLAGE_ISSUES) });
