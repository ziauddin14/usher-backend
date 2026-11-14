// Controlled, manual creation of a Pakistan Admin account by Central IT (CTO 6 Nov 2026).
//
// pnpm provision:pakistan-admin <ajeerCode> --name "<name>" [--name-ur "<Urdu name>"]
//      --nomination <reference> --approval <reference> --operator "<Central IT operator>"
//      [--central-it] [--admin] --db demo|live --confirm=<database name>
//
// --admin (CTO 14 Nov 2026) creates an Admin: the Pakistan-level account that alone changes data.
//
// --nomination = the central management authority's nomination; --approval = its confirmation by
// the authorized administrative process (two different documents). --central-it records a Central IT
// Department account. The account gets the pakistan role, password demo1234 with a forced change and
// no mobile (optional; the person adds it in their profile).
// Creates only — an existing ajeer code is refused, never promoted. Audit USER_PROVISION.
import { disconnectDb } from '../src/lib/db.js';
import { provisionPakistanAdmin } from '../src/modules/users/provision.js';
import { connectConfirmedDb, option, positional } from './admin-cli.js';

const USAGE =
  'Usage: pnpm provision:pakistan-admin <ajeerCode> --name "<name>" --nomination <ref> --approval <ref> --operator "<who>" [--central-it] [--admin] [--name-ur "<name>"] --db demo|live --confirm=<database name>';
const VALUE_OPTIONS = ['db', 'confirm', 'name', 'name-ur', 'nomination', 'approval', 'operator'];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ajeerCode = positional(args, VALUE_OPTIONS);
  const name = option(args, 'name');
  const nominationRef = option(args, 'nomination');
  const approvalRef = option(args, 'approval');
  const operator = option(args, 'operator');
  if (!ajeerCode || !name || !nominationRef || !approvalRef || !operator) {
    console.error(USAGE);
    process.exit(1);
  }
  const centralIt = args.includes('--central-it');
  const admin = args.includes('--admin');
  console.warn(
    `  provision     : ${ajeerCode} as ${admin ? 'Admin' : 'Pakistan Admin'}${centralIt ? ' (Central IT)' : ''}`,
  );
  await connectConfirmedDb(args, USAGE);
  const nameUr = option(args, 'name-ur');
  const result = await provisionPakistanAdmin({
    ajeerCode,
    name,
    ...(nameUr ? { nameUr } : {}),
    nominationRef,
    approvalRef,
    operator,
    ...(centralIt ? { department: 'CENTRAL_IT' as const } : {}),
    ...(admin ? { role: 'admin' as const } : {}),
  });
  if (!result.ok) {
    console.error(`Refused: ${result.reason} — ${result.message}`);
    await disconnectDb();
    process.exit(1);
  }
  console.warn(
    'Done (audited). Password demo1234 with a forced change; the mobile is optional (profile).',
  );
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
