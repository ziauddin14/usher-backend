// pnpm import:villages private/<file>.xlsx [--dry-run]     (run AFTER pnpm import:employees)
// Columns: Gaon ka naam, Tehsil, District, Zimmedar Ajeer Code (or the zimmedar's name).
// Villages are upserted by district + normalized name (status "approved") and assigned to their
// Ushar Zimmedar. Villages listed under a District/Division user go to the "district pool"
// (no zimmedar). Roman district names are matched through data/district-names.csv. Only the
// village sheet is read (never "Location"). Always writes to the live database (ushr_live).
// Unmatched villages / no-name rows / pool / conflicts → Excel report in backend/private/.
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { disconnectDb } from '../src/lib/db.js';
import { useLiveDb } from './live-db.js';
import {
  importVillages,
  readVillageSheet,
  writeVillageReport,
} from '../src/modules/import/villages.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: pnpm import:villages <file.xlsx> [--dry-run]');
    process.exit(1);
  }

  await useLiveDb({ dryRun });
  const path = resolve(file);
  const result = await importVillages(await readVillageSheet(path), { dryRun });

  const privateDir = join(process.cwd(), 'private');
  await mkdir(privateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = join(
    privateDir,
    `village-import-report-${basename(path).replace(/\.\w+$/, '')}-${stamp}.xlsx`,
  );
  await writeVillageReport(result, reportFile);

  console.warn(dryRun ? 'DRY RUN — nothing written.' : 'Import done.');
  console.warn(`  rows read                 : ${result.rows}`);
  console.warn(
    `  villages in file          : ${result.villages}  (+${result.duplicateRows} repeated rows)`,
  );
  console.warn(`  villages created          : ${result.created}${dryRun ? ' (would be)' : ''}`);
  console.warn(`  villages updated          : ${result.updated}${dryRun ? ' (would be)' : ''}`);
  console.warn(`  assigned to a zimmedar    : ${result.assigned}`);
  console.warn(`  not imported (no district): ${result.unmatchedVillages.length}`);
  console.warn(`  not imported (no name)    : ${result.noName.length} rows`);
  console.warn(`  district pool (no zimmedar): ${result.districtPool.length}`);
  console.warn(`  imported, zimmedar missing: ${result.unmatchedZimmedar.length}`);
  console.warn(`  one village, many zimmedar: ${result.conflicts.length}`);
  console.warn(`  report                    : ${reportFile}`);
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
