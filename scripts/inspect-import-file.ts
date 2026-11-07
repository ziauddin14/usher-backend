// pnpm inspect:file private/<file>.xlsx --kind employees|villages
// First look at an official file: sheets, header row, column mapping and counts. No database,
// nothing written; never prints names, Ajeer Codes or mobile numbers. Then run the import with
// --dry-run (see README "Real-data imports").
import { inspectFile } from '../src/modules/import/inspect.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const kindArg =
    args.find((a) => a.startsWith('--kind='))?.slice(7) ?? args[args.indexOf('--kind') + 1];
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--kind');
  if (!file || (kindArg !== 'employees' && kindArg !== 'villages')) {
    console.error('Usage: pnpm inspect:file <file.xlsx> --kind employees|villages');
    process.exit(1);
  }
  const report = await inspectFile(file, kindArg);
  console.warn(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
