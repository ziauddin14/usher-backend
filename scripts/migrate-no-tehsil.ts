// pnpm migrate:no-tehsil --dry-run
// pnpm migrate:no-tehsil --operator "<who>" --confirm=ushr_live
// One-time: no Tehsil level (CTO 13 Nov 2026). Tehsil accounts become zimmedaran of their District
// ("tehsil_town"), zimmedaran under a Tehsil move to the District, Tehsil units are deactivated.
// Then: pnpm import:employees (the 168 held accounts) → import:villages → import:donors.
import { dbNameOf, liveDbUri } from '../src/lib/databases.js';
import { disconnectDb } from '../src/lib/db.js';
import { migrateNoTehsil } from '../src/modules/import/no-tehsil.js';
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
  const r = await migrateNoTehsil({ dryRun, operator: `cli:${operator || 'dry-run'}` });
  const would = dryRun ? ' (would be)' : '';
  console.warn(dryRun ? 'DRY RUN — nothing written.' : 'Done.');
  console.warn(`  Tehsil accounts → zimmedar (tehsil_town): ${r.tehsilAccounts}${would}`);
  console.warn(`  zimmedaran moved to their District      : ${r.zimmedaranMoved}${would}`);
  console.warn(`  Tehsil units deactivated                : ${r.tehsilUnits}${would}`);
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
