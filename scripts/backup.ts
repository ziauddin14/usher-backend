// pnpm backup → exports every collection of MONGODB_URI to backups/<YYYY-MM-DD>/<collection>.json
// (Extended JSON, one array per file). backups/ is git-ignored; run weekly.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mongo } from 'mongoose';
import { connectDb, disconnectDb } from '../src/lib/db.js';
import { karachiDate } from '../src/lib/time.js';

async function main(): Promise<void> {
  const conn = await connectDb();
  const db = conn.connection.db;
  if (!db) throw new Error('No database connection');

  const dir = join(process.cwd(), 'backups', karachiDate());
  await mkdir(dir, { recursive: true });

  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections) {
    const docs = await db.collection(name).find({}).toArray();
    await writeFile(
      join(dir, `${name}.json`),
      mongo.BSON.EJSON.stringify(docs, undefined, 0, { relaxed: false }),
    );
    console.warn(`${name}: ${docs.length} documents`);
  }
  console.warn(`Backup written to ${dir}`);
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
