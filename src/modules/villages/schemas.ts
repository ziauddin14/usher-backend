import { z } from 'zod';

export const listVillagesQuery = z.object({ q: z.string().trim().max(60).optional() });

export const villageIdParams = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });
export const approveSchema = z.object({ name: z.string().trim().min(2).max(80).optional() });
export const mergeSchema = z.object({ intoId: z.string().regex(/^[a-f0-9]{24}$/i) });
export const assignSchema = z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/i) });

export const addVillageSchema = z.object({
  name: z.string().trim().min(2, 'name is too short').max(80),
});
