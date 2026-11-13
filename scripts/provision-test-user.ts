// pnpm provision:test-user --dry-run
// pnpm provision:test-user --operator "<who>" --confirm=ushr_live
// The test-mode Ushar Zimmedar (CTO 13 Nov 2026): sandbox units TEST (outside PK), the account
// 999999001 (initial password, must be changed at first login), three test Gaon with invented
// donors. Idempotent; touches nothing outside TEST. Always the live database.
import { dbNameOf, liveDbUri } from '../src/lib/databases.js';
import { disconnectDb } from '../src/lib/db.js';
import { provisionTestUser, TEST_AJEER_CODE } from '../src/modules/test-user/service.js';
import { useLiveDb } from './live-db.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const eq = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const at = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const operator = (eq('operator') ?? at('operator') ?? '').trim();
  if (!dryRun) {
    const expected = dbNameOf(liveDbUri(process.env));
    if (!operator || (eq('confirm') ?? at('confirm')) !== expected) {
      console.error(`A real run needs --operator "<who>" and --confirm=${expected}.`);
      process.exit(1);
    }
  }
  await useLiveDb({ dryRun });
  const r = await provisionTestUser({ dryRun, operator: `cli:${operator || 'dry-run'}` });
  console.warn(dryRun ? 'DRY RUN — nothing written.' : 'Done.');
  console.warn(`  sandbox units (TEST)  : ${r.units}`);
  console.warn(`  test zimmedar ${TEST_AJEER_CODE}: ${r.user}${dryRun ? ' (would be)' : ''}`);
  console.warn(`  test Gaon / donors    : ${r.gaon} / ${r.donors}`);
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
