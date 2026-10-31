// Two databases (CTO decision 31 Oct 2026): `ushr_demo` holds only the invented seed data,
// `ushr_live` holds only the real employee / village imports. The scripts refuse to mix them.

/** Database name of a mongodb:// or mongodb+srv:// URI ('' when none is given). */
export function dbNameOf(uri: string): string {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri);
  return decodeURIComponent(match?.[1] ?? '');
}

/** The real-data database: its name contains "live". */
export function isLiveDb(uri: string): boolean {
  return /live/i.test(dbNameOf(uri));
}

/** Same server, other database name. */
export function withDbName(uri: string, name: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^/]+)\/?[^?]*/, `$1/${name}`);
}

/**
 * The live database for the import scripts: LIVE_MONGODB_URI, or MONGODB_URI's server with the
 * database `ushr_live`. Throws when the result is not a live database.
 */
export function liveDbUri(env: NodeJS.ProcessEnv): string {
  const uri =
    env.LIVE_MONGODB_URI ??
    (env.MONGODB_URI ? withDbName(env.MONGODB_URI, 'ushr_live') : undefined);
  if (!uri) throw new Error('Set LIVE_MONGODB_URI (or MONGODB_URI) in backend/.env');
  if (!isLiveDb(uri)) {
    throw new Error(`Real data goes only into the live database; "${dbNameOf(uri)}" is not one.`);
  }
  return uri;
}
