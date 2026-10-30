// pnpm seed            → idempotent demo seed into MONGODB_URI
// pnpm seed --reset    → wipe demo collections first (needs SEED_CONFIRM=ushr_demo unless the DB is local)
import { disconnectDb } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { seedDemo } from '../src/seed/seed.js';

function isLocal(uri: string): boolean {
  return /^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri);
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const uri = env().MONGODB_URI;
  if (reset && !isLocal(uri) && process.env.SEED_CONFIRM !== 'ushr_demo') {
    console.error('Refusing --reset on a non-local database without SEED_CONFIRM=ushr_demo.');
    process.exit(1);
  }
  const result = await seedDemo({ reset });
  console.warn(
    `Seed done${reset ? ' (after reset)' : ''}: ${result.units} units, ${result.users} users, ${result.villages} villages.`,
  );
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
