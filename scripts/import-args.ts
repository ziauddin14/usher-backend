// Shared arguments of the import commands (employees, villages).
//   <file.xlsx> [--dry-run] | <file.xlsx> --operator "<who>" --confirm=<database name>
// A real run must name its operator (kept in the audit log) and confirm the database by name,
// so a slip of the keyboard can never write to the live database.
import { basename, resolve } from 'node:path';
import { dbNameOf, liveDbUri } from '../src/lib/databases.js';

export interface ImportArgs {
  dryRun: boolean;
  path: string;
  source: { file: string; operator: string };
}

function option(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export function parseImportArgs(argv: string[], command: string): ImportArgs {
  const usage = `Usage: pnpm ${command} <file.xlsx> --dry-run\n       pnpm ${command} <file.xlsx> --operator "<who>" --confirm=<database name>`;
  const dryRun = argv.includes('--dry-run');
  const values = new Set(
    ['--operator', '--confirm'].map((o) => argv.indexOf(o) + 1).filter((i) => i > 0),
  );
  const file = argv.find((a, i) => !a.startsWith('--') && !values.has(i));
  if (!file) {
    console.error(usage);
    process.exit(1);
  }
  const operator = option(argv, 'operator')?.trim() ?? '';
  if (!dryRun) {
    const expected = dbNameOf(liveDbUri(process.env));
    if (!operator || option(argv, 'confirm') !== expected) {
      console.error(`A real import needs --operator "<who>" and --confirm=${expected}.\n${usage}`);
      process.exit(1);
    }
  }
  const path = resolve(file);
  return {
    dryRun,
    path,
    source: { file: basename(path), operator: `cli:${operator || 'dry-run'}` },
  };
}
