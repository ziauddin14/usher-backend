// Meeting tasks (CTO 12 Nov 2026): ticked tasks are checked against settings.donorTasks.
import { AppError } from '../../lib/errors.js';
import type { DonorTaskDef } from '../settings/donor-tasks.js';
import type { TaskInput } from './schemas.js';

export type TaskReason =
  | 'UNKNOWN_TASK'
  | 'TASK_COUNT_REQUIRED'
  | 'TASK_COUNT_NOT_ALLOWED'
  | 'TASK_PARTS_REQUIRED'
  | 'TASK_PART_UNKNOWN';

const fail = (reason: TaskReason, task: string): never => {
  throw new AppError(400, 'VALIDATION_FAILED', `Task "${task}": ${reason}`, { reason, task });
};

/**
 * Checked and normalized tasks, in settings order: a count task needs its number (≥ 1), a task
 * with parts needs at least one known part, and no other task carries either. `defs` is the
 * meeting task list or the day's other-work list.
 */
export function checkTasks(tasks: TaskInput[], defs: DonorTaskDef[]): TaskInput[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out = tasks.map((t) => {
    const def = byId.get(t.id) ?? fail('UNKNOWN_TASK', t.id);
    if (def.count && t.count === undefined) fail('TASK_COUNT_REQUIRED', t.id);
    if (!def.count && t.count !== undefined) fail('TASK_COUNT_NOT_ALLOWED', t.id);
    const partIds = (def.parts ?? []).map((p) => p.id);
    if (partIds.length > 0 && !t.parts?.length) fail('TASK_PARTS_REQUIRED', t.id);
    if (t.parts?.some((p) => !partIds.includes(p))) fail('TASK_PART_UNKNOWN', t.id);
    return {
      id: t.id,
      ...(t.count !== undefined ? { count: t.count } : {}),
      // Parts in settings order, each once.
      ...(t.parts ? { parts: partIds.filter((p) => t.parts!.includes(p)) } : {}),
    };
  });
  const order = (id: string) => byId.get(id)!.order;
  return out.sort((a, b) => order(a.id) - order(b.id));
}
