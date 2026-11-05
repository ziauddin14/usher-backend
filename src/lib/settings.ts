import { Setting, type SettingDoc } from '../models/setting.js';
import { connectDb } from './db.js';
import { AppError } from './errors.js';
import type { RewardRules } from '../modules/reports/reward.js';
import { DEFAULT_SETTINGS } from '../modules/settings/defaults.js';

const TTL_MS = 60_000;

let cache: { value: SettingDoc; at: number } | undefined;

/** The `settings` document, cached for 60 s per (serverless) instance. */
export async function getSettings(): Promise<SettingDoc> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  await connectDb();
  const doc = await Setting.findById('app').lean();
  if (!doc) {
    throw new AppError(500, 'INTERNAL', 'Settings missing — run the seed');
  }
  cache = { value: doc, at: Date.now() };
  return doc;
}

export function clearSettingsCache(): void {
  cache = undefined;
}

/** Insert the default settings when the database has none (the live database gets no seed). */
export async function ensureSettings(): Promise<void> {
  await connectDb();
  await Setting.updateOne({ _id: 'app' }, { $setOnInsert: DEFAULT_SETTINGS }, { upsert: true });
  clearSettingsCache();
}

/** Plain reward rules (periods, divisor, tiers) from the settings document — never hard-coded. */
export async function getRewardRules(): Promise<RewardRules> {
  const r = (await getSettings()).reward;
  if (!r) throw new AppError(500, 'INTERNAL', 'Reward settings missing');
  return {
    periods: r.periods.map((p) => ({ id: p.id, startMonth: p.startMonth, months: p.months })),
    divisor: r.divisor,
    tiers: r.tiers.map((t) => ({ minAvg: t.minAvg, amount: t.amount })),
  };
}
