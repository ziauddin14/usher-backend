// Central IT: activate or deactivate a Pakistan Admin account (CTO 6 Nov 2026), audited.
//
// pnpm pakistan-admin:status <ajeerCode> --active|--inactive --operator "<who>"
//      --reference <decision reference> --db demo|live --confirm=<database name>
//
// Only for pakistan-level / centrally provisioned accounts (everyone else is managed by their
// supervisors on the dashboard). A deactivated account's sessions stop at the next request.
// Audit USER_STATUS with the operator and the reference.
import { disconnectDb } from '../src/lib/db.js';
import { setPakistanAdminActive } from '../src/modules/users/provision.js';
import { connectConfirmedDb, option, positional } from './admin-cli.js';

const USAGE =
  'Usage: pnpm pakistan-admin:status <ajeerCode> --active|--inactive --operator "<who>" --reference <ref> --db demo|live --confirm=<database name>';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ajeerCode = positional(args, ['db', 'confirm', 'operator', 'reference']);
  const operator = option(args, 'operator');
  const reference = option(args, 'reference');
  const active = args.includes('--active');
  const inactive = args.includes('--inactive');
  if (!ajeerCode || !operator || !reference || active === inactive) {
    console.error(USAGE);
    process.exit(1);
  }
  console.warn(`  status        : ${ajeerCode} → ${active ? 'active' : 'inactive'}`);
  await connectConfirmedDb(args, USAGE);
  const result = await setPakistanAdminActive({ ajeerCode, isActive: active, operator, reference });
  if (!result.ok) {
    console.error(`Refused: ${result.reason} — ${result.message}`);
    await disconnectDb();
    process.exit(1);
  }
  console.warn(result.changed ? 'Done (audited).' : 'No change — already so.');
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
