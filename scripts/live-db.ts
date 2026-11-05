// Import scripts write real data, so they always use the live database (never ushr_demo).
import { connectDb } from '../src/lib/db.js';
import { dbNameOf, liveDbUri } from '../src/lib/databases.js';
import { resetEnvCache } from '../src/lib/env.js';
import { ensureSettings } from '../src/lib/settings.js';

/**
 * Point this process at the live database and connect. A real run also makes sure the database
 * has a settings document; a `--dry-run` writes nothing at all.
 */
export async function useLiveDb({ dryRun }: { dryRun: boolean }): Promise<void> {
  process.env.MONGODB_URI = liveDbUri(process.env);
  resetEnvCache();
  console.warn(`  database      : ${dbNameOf(process.env.MONGODB_URI)}`);
  await connectDb();
  if (!dryRun) await ensureSettings();
}
