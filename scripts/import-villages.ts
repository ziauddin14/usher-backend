// pnpm import:villages private/<gaon>.xlsx --hr private/<hr>.xlsx --dry-run
// pnpm import:villages private/<gaon>.xlsx --hr private/<hr>.xlsx --operator "<who>" --confirm=ushr_live
// Run AFTER pnpm import:employees. Columns: Gaon ka naam, Tehsil, District, Employee Code (= Ajeer
// Code; exact match), Usher Zimmedar Name (reference only, never matched).
// Villages are upserted by district + normalized name (status "approved"). Only a user whose role
// is zimmedar gets an assignment; villages listed under a supervisor go to the "district pool".
// --hr is required: Ajeer Codes the HR file holds back (/2, /3 …) or the employee import rejects
// never get villages — those rows are exceptions (CTO 7 Nov 2026). Roman district names are
// matched through data/district-names.csv. Only the village sheet is read (never "Location").
// Always uses the live database (ushr_live). Exceptions → Excel report in private/ (git-ignored).
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseImportArgs } from './import-args.js';
import { disconnectDb } from '../src/lib/db.js';
import { useLiveDb } from './live-db.js';
import {
  hrCodesFromPlan,
  readEmployeeSheet,
  validateRows,
} from '../src/modules/import/employees.js';
import {
  importVillages,
  readVillageSheet,
  writeVillageReport,
} from '../src/modules/import/villages.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { dryRun, path, source } = parseImportArgs(argv, 'import:villages');
  const hrArg = argv[argv.indexOf('--hr') + 1];
  if (!argv.includes('--hr') || !hrArg || hrArg.startsWith('--')) {
    console.error('--hr <the HR employee file> is required (held / rejected Ajeer Codes).');
    process.exit(1);
  }
  const hr = hrCodesFromPlan(validateRows(await readEmployeeSheet(resolve(hrArg))));

  await useLiveDb({ dryRun });
  const result = await importVillages(await readVillageSheet(path), { dryRun, source, hr });

  const privateDir = join(process.cwd(), 'private');
  await mkdir(privateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = join(
    privateDir,
    `village-import-report-${basename(path).replace(/\.\w+$/, '')}-${stamp}.xlsx`,
  );
  await writeVillageReport(result, reportFile);
  for (const line of villageSummary(result, dryRun)) console.warn(line);
  console.warn(`  report                     : ${reportFile}`);
  await disconnectDb();
}

/** Counts only — no names, codes or mobiles on the terminal. */
export function villageSummary(
  result: Awaited<ReturnType<typeof importVillages>>,
  dryRun: boolean,
): string[] {
  const would = dryRun ? ' (would be)' : '';
  return [
    dryRun ? 'DRY RUN — nothing written.' : 'Import done.',
    `  rows read                  : ${result.rows}`,
    `  villages in file           : ${result.villages}  (+${result.duplicateRows} repeated rows, merged)`,
    `  villages created           : ${result.created}${would}`,
    `  villages updated           : ${result.updated}${would}`,
    `  assigned to a zimmedar     : ${result.assigned}`,
    `  district pool (supervisor) : ${result.districtPool.length}`,
    `  zimmedar not matched       : ${result.unmatchedZimmedar.length}`,
    `  held /2, /3 code (rows)    : ${result.heldCode.length}`,
    `  employee not imported (rows): ${result.notImportedEmployee.length}`,
    `  district differs (rows)    : ${result.districtMismatch.length}  — not imported`,
    `  district not found (rows)  : ${result.unmatchedVillages.length}  — not imported`,
    `  no name (rows)             : ${result.noName.length}  — not imported`,
    `  one village, many zimmedar : ${result.conflicts.length}`,
  ];
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
