// pnpm designate:verifier <ajeerCode> --db demo|live --confirm=<database name>
//      → give VERIFY_SUBA_MOBILE to a pakistan account (add --revoke to take it away)
// The operator always names the database: `--db demo` = MONGODB_URI (demo/test databases only),
// `--db live` = the live database (same rule as the imports). Nothing is written unless
// --confirm equals that database's name (like SEED_CONFIRM). Only an active pakistan-level account
// can be designated (CTO 5 Nov 2026: "designated Pakistan Admin only"). Every change is audited
// (USER_PERMISSION). Who is designated is the organization's decision.
import { connectDb, disconnectDb } from '../src/lib/db.js';
import { adminTargetUri, dbNameOf } from '../src/lib/databases.js';
import { resetEnvCache } from '../src/lib/env.js';
import { setPermission } from '../src/modules/users/permissions.js';

const USAGE =
  'Usage: pnpm designate:verifier <ajeerCode> --db demo|live --confirm=<database name> [--revoke]';

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = option(args, 'db');
  const ajeerCode = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--db');
  const revoke = args.includes('--revoke');
  if (!ajeerCode || !/^\d{3,9}$/.test(ajeerCode)) {
    console.error(USAGE);
    process.exit(1);
  }
  let uri: string;
  try {
    uri = adminTargetUri(target, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exit(1);
  }
  const name = dbNameOf(uri);
  console.warn(`  database      : ${name}`);
  console.warn(`  ${revoke ? 'revoke' : 'grant '}        : VERIFY_SUBA_MOBILE → ${ajeerCode}`);
  if (option(args, 'confirm') !== name) {
    console.error(`Nothing written. Add --confirm=${name} to confirm this database.`);
    process.exit(1);
  }
  process.env.MONGODB_URI = uri;
  resetEnvCache();
  await connectDb();
  const result = await setPermission({
    ajeerCode,
    permission: 'VERIFY_SUBA_MOBILE',
    grant: !revoke,
    actor: 'cli',
  });
  if (!result.ok) {
    console.error(
      `Refused: ${result.reason} (only an active pakistan-level account can be designated).`,
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
