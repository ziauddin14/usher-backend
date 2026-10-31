// pnpm import:employees private/<file>.xlsx [--dry-run]
// Columns: Ajeer Code, Naam, Walid, Zimmedari (Ushar/Tehsil-Town/Event/District/Division/Suba),
//          Suba, Division, District, Mobile.
// Upsert by Ajeer Code · new units created · existing passwords never changed · new users get
// password 123 + forced change. Always writes to the live database (ushr_live). An Excel report
// (rejected rows, warnings, codes written as /1 and /2) is saved in backend/private/ (git-ignored).
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { disconnectDb } from '../src/lib/db.js';
import { useLiveDb } from './live-db.js';
import {
  importEmployees,
  readEmployeeSheet,
  writeEmployeeReport,
} from '../src/modules/import/employees.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: pnpm import:employees <file.xlsx> [--dry-run]');
    process.exit(1);
  }

  await useLiveDb();
  const path = resolve(file);
  const rows = await readEmployeeSheet(path);
  const result = await importEmployees(rows, { dryRun });

  const privateDir = join(process.cwd(), 'private');
  await mkdir(privateDir, { recursive: true });
  const reportFile = join(
    privateDir,
    `employee-import-report-${basename(path).replace(/\.\w+$/, '')}-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`,
  );
  await writeEmployeeReport(result, reportFile);

  console.warn(`${dryRun ? 'DRY RUN — nothing written.' : 'Import done.'}`);
  console.warn(`  rows read     : ${result.rows}`);
  console.warn(`  users created : ${result.created}${dryRun ? ' (would be)' : ''}`);
  console.warn(`  users updated : ${result.updated}${dryRun ? ' (would be)' : ''}`);
  console.warn(`  new units     : ${result.newUnits.length}`);
  for (const u of result.newUnits) console.warn(`      + ${u.level} ${u.name} (${u.path})`);
  console.warn(`  warnings      : ${result.warnings.length}`);
  console.warn(
    `  same code twice: ${result.sameCode.length} (e.g. /1 and /2 — sheet "Aik code - 1 aur 2")`,
  );
  console.warn(`  code not /1   : ${result.otherSuffix.length} (sheet "Code 2, 3")`);
  console.warn(`  rows rejected : ${result.errors.length}`);
  for (const e of result.errors.slice(0, 50)) {
    console.warn(`      row ${e.row}${e.ajeerCode ? ` [${e.ajeerCode}]` : ''}: ${e.message}`);
  }
  if (result.errors.length > 50)
    console.warn(`      … ${result.errors.length - 50} more in the report`);
  console.warn(`  report        : ${reportFile}`);
  await disconnectDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
