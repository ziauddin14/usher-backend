import { Setting, type SettingDoc } from '../models/setting.js';
import { connectDb } from './db.js';
import { AppError } from './errors.js';

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
