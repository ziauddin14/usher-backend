// pnpm designate:verifier <ajeerCode> --permission VERIFY_SUBA_MOBILE|VERIFY_PAKISTAN_MOBILE
//      --operator "<Central IT operator>" --reference <decision reference>
//      --db demo|live --confirm=<database name> [--revoke]
// The operator is the audit actor and the reference (the authority's decision / letter) is kept in
// the audit details, so every designation and revoke says who did it and on whose decision.
// The operator always names the database: `--db demo` = MONGODB_URI (demo/test databases only),
// `--db live` = the live database (same rule as the imports). Nothing is written unless
// --confirm equals that database's name (like SEED_CONFIRM).
// VERIFY_SUBA_MOBILE: only an active pakistan-level account ("designated Pakistan Admin").
// VERIFY_PAKISTAN_MOBILE: only an active pakistan-level account of the Central IT Department
// ("designated Central IT verifier", provisioned with --central-it). Every change is audited
// (USER_PERMISSION). Who is designated is the organization's decision.
import { disconnectDb } from '../src/lib/db.js';
import { PERMISSIONS, type Permission } from '../src/models/user.js';
import { setPermission } from '../src/modules/users/permissions.js';
import { connectConfirmedDb, option, positional } from './admin-cli.js';

const USAGE =
  'Usage: pnpm designate:verifier <ajeerCode> --permission VERIFY_SUBA_MOBILE|VERIFY_PAKISTAN_MOBILE --operator "<who>" --reference <ref> --db demo|live --confirm=<database name> [--revoke]';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ajeerCode = positional(args, ['db', 'confirm', 'permission', 'operator', 'reference']);
  const permission = option(args, 'permission');
  const operator = option(args, 'operator')?.trim();
  const reference = option(args, 'reference')?.trim();
  if (!operator || !/^[\p{L}\p{N} ._-]{2,60}$/u.test(operator)) {
    console.error('Name the operator: --operator "<who>"');
    console.error(USAGE);
    process.exit(1);
  }
  if (!reference || !/^[\p{L}\p{N} ./_#:()-]{3,100}$/u.test(reference)) {
    console.error('Give the decision reference: --reference <ref>');
    console.error(USAGE);
    process.exit(1);
  }
  const revoke = args.includes('--revoke');
  if (!ajeerCode || !/^\d{3,9}$/.test(ajeerCode)) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!PERMISSIONS.includes(permission as Permission)) {
    console.error(`Name the permission: --permission ${PERMISSIONS.join('|')}`);
    console.error(USAGE);
    process.exit(1);
  }
  console.warn(`  ${revoke ? 'revoke' : 'grant '}        : ${permission} → ${ajeerCode}`);
  await connectConfirmedDb(args, USAGE);
  const result = await setPermission({
    ajeerCode,
    permission: permission as Permission,
    grant: !revoke,
    actor: operator,
    reference,
  });
  if (!result.ok) {
    console.error(
      `Refused: ${result.reason} (VERIFY_SUBA_MOBILE: an active pakistan account; VERIFY_PAKISTAN_MOBILE: an active pakistan account of the Central IT Department).`,
    );
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
