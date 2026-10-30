import { z } from 'zod';

export const listVillagesQuery = z.object({ q: z.string().trim().max(60).optional() });

export const addVillageSchema = z.object({
  name: z.string().trim().min(2, 'name is too short').max(80),
});
