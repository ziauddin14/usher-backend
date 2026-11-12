import { z } from 'zod';
import { normalizeMobile } from '../../lib/mobile.js';

const count = z.number().int().min(0).max(100_000);
/** Money = integer rupees. */
const rupees = z.number().int().min(0).max(100_000_000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const objectId = z.string().regex(/^[a-f0-9]{24}$/i);

export const ENTRY_TYPES = ['amli', 'rukhsat', 'course', 'qafila', 'mashwara_full'] as const;

const travelStart = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('bike'), meterStart: count.max(10_000_000) }),
  // Bus fare is written when the day ends (CTO 11 Nov 2026); an older client may still send it here.
  z.object({ mode: z.literal('bus'), fare: rupees.optional() }),
]);

export const createJadwalSchema = z
  .object({
    date: date.optional(),
    entryType: z.enum(ENTRY_TYPES),
    travel: travelStart.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((b) => b.entryType !== 'amli' || b.travel, {
    message: 'travel is required for an amli jadwal',
    path: ['travel'],
  });

export const patchJadwalSchema = z.object({
  travel: travelStart.optional(),
  note: z.string().trim().max(500).optional(),
});

export const listJadwalsQuery = z.object({ from: date.optional(), to: date.optional() });

export const jadwalIdParams = z.object({ id: objectId });
export const visitParams = z.object({ id: objectId, visitId: objectId });

export const addVisitSchema = z.object({ villageId: objectId });

/** A ticked meeting task (checked against settings.donorTasks in the service). */
const taskInput = z.object({
  id: z.string().min(1).max(40),
  count: z.number().int().min(1).max(100_000).optional(),
  parts: z.array(z.string().min(1).max(40)).min(1).max(10).optional(),
});
export const tasksInput = z
  .array(taskInput)
  .max(20)
  .refine((t) => new Set(t.map((x) => x.id)).size === t.length, 'a task is listed twice');
export type TaskInput = z.infer<typeof taskInput>;

export const donorsSchema = z.object({
  oldMet: count,
  oldTasks: tasksInput.optional(),
  newDonors: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        mobile: z
          .string()
          .trim()
          .max(20)
          .optional()
          .transform((v, ctx) => {
            if (!v) return undefined;
            const m = normalizeMobile(v);
            if (!m) ctx.addIssue({ code: 'custom', message: 'invalid mobile (03XXXXXXXXX)' });
            return m ?? undefined;
          }),
        acres: z.number().min(0).max(100_000).optional(),
        tasks: tasksInput.optional(),
      }),
    )
    .max(50),
});

export const atiyatSchema = z
  .object({
    entries: z
      .array(
        z.object({
          type: z.enum(['niyyat', 'wusooli']),
          category: z.string().min(1).max(40),
          kind: z.enum(['naqd', 'jins']),
          amount: rupees.min(1),
          detail: z.string().trim().max(120).optional(),
        }),
      )
      .max(100),
    gsb: z.object({ boxesOpened: count, amount: rupees }).optional(),
  })
  .refine((b) => b.entries.every((e) => e.kind === 'jins' || !e.detail), {
    message: 'detail is only for jins (in-kind) entries',
    path: ['entries'],
  });

export const ijtimaSchema = z
  .object({
    held: z.boolean(),
    type: z.enum(['kisan', 'zamindar']).optional(),
    participants: count.optional(),
  })
  .refine((b) => !b.held || (b.type && b.participants && b.participants >= 1), {
    message: 'type and participants (≥ 1) are required when the ijtima was held',
    path: ['participants'],
  });

export const mashwaraSchema = z
  .object({
    held: z.boolean(),
    participants: count.optional(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((b) => !b.held || (b.participants && b.participants >= 1), {
    message: 'participants (≥ 1) are required when the mashwara was held',
    path: ['participants'],
  });

export const submitSchema = z.object({
  meterEnd: count.max(10_000_000).optional(),
  /** Bus days: the day's fare, entered on the End screen (CTO 11 Nov 2026). */
  fare: rupees.optional(),
  /** The day's other work (settings.otherWork); needed when the day has no Gaon (CTO 12 Nov 2026). */
  otherTasks: tasksInput.optional(),
  note: z.string().trim().max(500).optional(),
});

export const reopenSchema = z.object({ reason: z.string().trim().min(5).max(300) });

/** POST /jadwals/:id/duty-approval — official-duty decision on a full-day mashwara. */
export const dutyApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  /** The decision the caller saw (null = none yet); a different current decision → 409. */
  expected: z.enum(['approved', 'rejected']).nullable(),
  reason: z.string().trim().max(300).optional(),
});
