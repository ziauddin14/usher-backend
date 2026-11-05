// pnpm seed             → idempotent demo seed into MONGODB_URI (ushr_demo; never a live database)
// pnpm seed --if-empty  → seed only when the database has no users yet (start-local.ps1)
// pnpm seed --reset     → wipe demo collections first (needs SEED_CONFIRM=ushr_demo unless the DB is local)
import { connectDb, disconnectDb } from '../src/lib/db.js';
import { dbNameOf, isLiveDb } from '../src/lib/databases.js';
import { env } from '../src/lib/env.js';
import { User } from '../src/models/user.js';
import { seedDemo } from '../src/seed/seed.js';

function isLocal(uri: string): boolean {
  return /^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri);
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const ifEmpty = process.argv.includes('--if-empty');
  const uri = env().MONGODB_URI;
  if (isLiveDb(uri)) {
    console.error(`Refusing to seed invented data into the live database "${dbNameOf(uri)}".`);
    process.exit(1);
  }
  if (reset && !isLocal(uri) && process.env.SEED_CONFIRM !== 'ushr_demo') {
    console.error('Refusing --reset on a non-local database without SEED_CONFIRM=ushr_demo.');
    process.exit(1);
  }
  if (ifEmpty && !reset) {
    await connectDb();
    const users = await User.estimatedDocumentCount();
    if (users > 0) {
      console.warn(`Database already has ${users} users — seed skipped.`);
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
