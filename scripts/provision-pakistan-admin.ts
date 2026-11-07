// Controlled, manual creation of a Pakistan Admin account by Central IT (CTO 6 Nov 2026).
//
// pnpm provision:pakistan-admin <ajeerCode> --name "<name>" [--name-ur "<Urdu name>"]
//      --nomination <reference> --approval <reference> --operator "<Central IT operator>"
//      [--central-it] --db demo|live --confirm=<database name>
//
// --nomination = the central management authority's nomination; --approval = its confirmation by
// the authorized administrative process (two different documents). --central-it marks a Central IT
// Department account (needed before VERIFY_PAKISTAN_MOBILE can be designated). The account gets
// the pakistan role, password demo1234 with a forced change, no permission and no mobile: the person
// types the mobile at the first login, and it waits for the designated Central IT verifier.
// Creates only — an existing ajeer code is refused, never promoted. Audit USER_PROVISION.
import { disconnectDb } from '../src/lib/db.js';
import { provisionPakistanAdmin } from '../src/modules/users/provision.js';
import { connectConfirmedDb, option, positional } from './admin-cli.js';

const USAGE =
  'Usage: pnpm provision:pakistan-admin <ajeerCode> --name "<name>" --nomination <ref> --approval <ref> --operator "<who>" [--central-it] [--name-ur "<name>"] --db demo|live --confirm=<database name>';
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
  console.warn(
    `  provision     : ${ajeerCode} as Pakistan Admin${centralIt ? ' (Central IT)' : ''}`,
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
  });
  if (!result.ok) {
    console.error(`Refused: ${result.reason} — ${result.message}`);
    await disconnectDb();
    process.exit(1);
  }
  console.warn(
    'Done (audited). Password demo1234 with a forced change; no permission; the mobile is typed at the first login and waits for the designated Central IT verifier.',
  );
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
