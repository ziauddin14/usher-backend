// pnpm seed             → idempotent demo seed into MONGODB_URI (ushr_demo; never a live database)
// pnpm seed --if-empty  → full seed only when the database has no users yet; otherwise only top up the
//                         invented jadwal history to yesterday (start-local.ps1, every start)
// pnpm seed --reset     → wipe demo collections first (always needs SEED_CONFIRM=<database name>,
//                         e.g. SEED_CONFIRM=ushr_demo)
import { connectDb, disconnectDb } from '../src/lib/db.js';
import { seedRefusal } from '../src/lib/databases.js';
import { env } from '../src/lib/env.js';
import { User } from '../src/models/user.js';
import { seedHistory } from '../src/seed/history.js';
import { seedDemo } from '../src/seed/seed.js';

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const ifEmpty = process.argv.includes('--if-empty');
  const uri = env().MONGODB_URI;
  const refusal = seedRefusal(uri, reset, process.env.SEED_CONFIRM);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  if (ifEmpty && !reset) {
    await connectDb();
    const users = await User.estimatedDocumentCount();
    if (users > 0) {
      // Users are kept as they are; only missing history days (e.g. an older demo database
      // without Dec 2025 – May 2026, or the days since the last start) are added.
      const { jadwals } = await seedHistory();
      console.warn(
        `Database already has ${users} users — seed skipped; ${jadwals} new history days.`,
      );
      await disconnectDb();
      return;
    }
  }
  const result = await seedDemo({ reset, history: true });
  console.warn(
    `Seed done${reset ? ' (after reset)' : ''}: ${result.units} units, ${result.users} users, ${result.villages} villages, ${result.jadwals} new history days.`,
  );
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
