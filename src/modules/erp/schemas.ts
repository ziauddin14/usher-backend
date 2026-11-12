import { z } from 'zod';

/** POST /erp/uploads?name=…&commit=true|false — the file itself is the raw request body. */
export const uploadQuery = z.object({
  /** The file name as chosen in the browser (shown in the upload list; no folder). */
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    // Keep the last part of a "C:/…" or "C:\…" path (92 = backslash).
    .transform((n) => n.split('/').pop()!.split(String.fromCharCode(92)).pop()!),
  commit: z.enum(['true', 'false']).default('false'),
});

/** Largest accepted file (a day of receipts is far smaller). */
export const MAX_ERP_FILE_BYTES = 5 * 1024 * 1024;
