import { z } from 'zod';

export const listVillagesQuery = z.object({ q: z.string().trim().max(60).optional() });

export const villageIdParams = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });
export const approveSchema = z.object({ name: z.string().trim().min(2).max(80).optional() });
export const mergeSchema = z.object({ intoId: z.string().regex(/^[a-f0-9]{24}$/i) });
export const assignSchema = z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/i) });

export const addVillageSchema = z.object({
  name: z.string().trim().min(2, 'name is too short').max(80),
});

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
