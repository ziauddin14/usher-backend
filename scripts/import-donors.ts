// pnpm import:donors "private/<donor list>.csv" --dry-run
// pnpm import:donors "private/<donor list>.csv" --operator "<who>" --confirm=ushr_live
// Run AFTER the employee and Gaon imports. Shoba Ushar's donor list → donors of each Gaon (CTO 12
// Nov 2026). Donors whose Gaon is not in the Gaon list go to the report; run the same file again
// after the Gaon list is fixed — nothing is doubled. Always the live database (ushr_live).
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseImportArgs } from './import-args.js';
import { useLiveDb } from './live-db.js';
import { disconnectDb } from '../src/lib/db.js';
import { importDonors, readDonorFile, writeDonorReport } from '../src/modules/import/donors.js';

async function main(): Promise<void> {
  const { dryRun, path, source } = parseImportArgs(process.argv.slice(2), 'import:donors');
  await useLiveDb({ dryRun });
  const r = await importDonors(await readDonorFile(path), { dryRun, source });

  const privateDir = join(process.cwd(), 'private');
  await mkdir(privateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = join(
    privateDir,
    `donor-import-report-${basename(path).replace(/\.\w+$/, '')}-${stamp}.xlsx`,
  );
  await writeDonorReport(r, reportFile);
  // Counts only — no names or numbers on the terminal.
  const would = dryRun ? ' (would be)' : '';
  for (const line of [
    dryRun ? 'DRY RUN — nothing written.' : 'Import done.',
    `  rows read                 : ${r.rows}`,
    `  donors in file            : ${r.donorsInFile}  (+${r.repeatedRows} repeated rows, merged)`,
    `  with mobile               : ${r.withMobile}`,
    `  donors created            : ${r.created}${would}`,
    `  donors updated            : ${r.updated}${would}`,
    `  donors unchanged          : ${r.unchanged}`,
    `  Gaon local zimmedar set   : ${r.localZimmedarSet}${would}`,
    `  District found by ID only : ${r.districtFromId}`,
    `  Gaon not found (rows)     : ${r.villageNotFound.length}  — not imported`,
    `  District not found (rows) : ${r.districtNotFound.length}  — not imported`,
    `  donor name empty (rows)   : ${r.noDonorName.length}  — not imported`,
    `  bad mobile (rows)         : ${r.badMobile.length}  — imported without number`,
    `  report                    : ${reportFile}`,
  ])
    console.warn(line);
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
