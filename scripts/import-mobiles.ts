// pnpm import:mobiles private/<kpi-file>.xlsx [--dry-run]     (run AFTER pnpm import:employees)
// Reads Ajeer Code + "رجسٹرڈ موبائل نمبر" and gives the number to imported users who have none.
// A number already on record is never changed. Always writes to the live database (ushr_live).
// Excel report (numbers set, different numbers, problems, users still without a number) is saved
// in backend/private/ (git-ignored). The console shows counts only, never numbers.
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { disconnectDb } from '../src/lib/db.js';
import {
  importMobiles,
  readMobileSheet,
  writeMobileReport,
} from '../src/modules/import/mobiles.js';
import { useLiveDb } from './live-db.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: pnpm import:mobiles <file.xlsx> [--dry-run]');
    process.exit(1);
  }

  await useLiveDb({ dryRun });
  const path = resolve(file);
  const result = await importMobiles(await readMobileSheet(path), { dryRun });

  const privateDir = join(process.cwd(), 'private');
  await mkdir(privateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = join(
    privateDir,
    `mobile-import-report-${basename(path).replace(/\.\w+$/, '')}-${stamp}.xlsx`,
  );
  await writeMobileReport(result, reportFile);

  console.warn(dryRun ? 'DRY RUN — nothing written.' : 'Import done.');
  console.warn(`  rows read              : ${result.rows}`);
  console.warn(`  numbers set            : ${result.set.length}${dryRun ? ' (would be)' : ''}`);
  console.warn(`  already the same       : ${result.unchanged}`);
  console.warn(`  different (not changed): ${result.different.length}`);
  console.warn(`  problems               : ${result.problems.length}`);
  console.warn(`  users still without one: ${result.stillMissing.length}`);
  console.warn(`  report                 : ${reportFile}`);
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
