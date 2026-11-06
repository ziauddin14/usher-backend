// Shared by the central admin commands (designate:verifier, provision:pakistan-admin): the operator
// always names the database (--db demo|live) and confirms it by name (--confirm=<database name>).
import { connectDb } from '../src/lib/db.js';
import { adminTargetUri, dbNameOf } from '../src/lib/databases.js';
import { resetEnvCache } from '../src/lib/env.js';

/** `--name value` or `--name=value`; undefined when the value is missing (or is another flag). */
export function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) {
    const value = args[i + 1];
    return value === undefined || value.startsWith('--') ? undefined : value;
  }
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** The first bare argument that is not the value of a `--option value` pair. */
export function positional(args: string[], valueOptions: string[]): string | undefined {
  return args.find(
    (a, i) => !a.startsWith('--') && !valueOptions.some((o) => args[i - 1] === `--${o}`),
  );
}

/**
 * Resolve the named database, print it, and connect only when --confirm equals its name.
 * Exits the process (code 1) on any refusal; nothing is written then.
 */
export async function connectConfirmedDb(args: string[], usage: string): Promise<string> {
  let uri: string;
  try {
    uri = adminTargetUri(option(args, 'db'), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    process.exit(1);
  }
  const name = dbNameOf(uri);
  console.warn(`  database      : ${name}`);
  if (option(args, 'confirm') !== name) {
    console.error(`Nothing written. Add --confirm=${name} to confirm this database.`);
    process.exit(1);
  }
  process.env.MONGODB_URI = uri;
  resetEnvCache();
  await connectDb();
  return name;
}
