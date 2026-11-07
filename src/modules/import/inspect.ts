// First look at an official file before any dry run (CTO 7 Nov 2026): which sheet and header row
// are used, how the headers map to the import columns, and counts of what the import would find.
// No database, nothing written. Prints header texts, unit names and Zimmedari values only — never
// names, Ajeer Codes or mobile numbers.
import {
  headerKey,
  inspectSheets,
  loadWorkbook,
  readRows,
  type SheetInspection,
} from '../../lib/xlsx.js';
import { COLUMN_KEYS as EMPLOYEE_COLUMNS, validateRows, ZIMMEDARI_MAP } from './employees.js';
import { COLUMN_KEYS as VILLAGE_COLUMNS } from './villages.js';

type EmployeeColumn = keyof typeof EMPLOYEE_COLUMNS;
type VillageColumn = keyof typeof VILLAGE_COLUMNS;

export type FileKind = 'employees' | 'villages';

const count = <T>(items: T[], key: (t: T) => string) => {
  const map = new Map<string, number>();
  for (const i of items) map.set(key(i), (map.get(key(i)) ?? 0) + 1);
  return [...map].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
};

export interface EmployeeFileReport {
  kind: 'employees';
  sheets: SheetInspection<string>[];
  rows: number;
  importable: number;
  rejected: { reason: string; n: number }[];
  noMobile: number;
  /** /2, /3 … rows: held, never imported (CTO decides after seeing the file). */
  heldSuffix: { suffix: string; n: number }[];
  sameCode: number;
  zimmedari: { value: string; n: number; mapsTo: string | null }[];
  units: { suba: number; division: number; district: number };
}

export interface VillageFileReport {
  kind: 'villages';
  sheets: SheetInspection<string>[];
  rows: number;
  noName: number;
  withAjeerCode: number;
  withZimmedarNameOnly: number;
  withoutZimmedar: number;
  withoutDistrict: number;
  districts: { value: string; n: number }[];
}

/** Rejection messages without the row-specific parts (codes, quoted values) for counting. */
const reasonOf = (message: string) =>
  message
    .split('; ')
    .map((m) => m.replace(/"[^"]*"/g, '"…"').replace(/\(login code \d+; first row kept\)/, ''))
    .map((m) => m.trim());

export async function inspectFile(
  file: string,
  kind: FileKind,
): Promise<EmployeeFileReport | VillageFileReport> {
  const workbook = await loadWorkbook(file);
  if (kind === 'employees') {
    const sheets = inspectSheets<EmployeeColumn>(workbook, EMPLOYEE_COLUMNS, 'ajeerCode');
    const rows = readRows<EmployeeColumn>(workbook, EMPLOYEE_COLUMNS, 'ajeerCode');
    const plan = validateRows(rows);
    const zimmedari = count(rows, (r) => (r.values.zimmedari ?? '').replace(/\s+/g, ' ').trim());
    const distinct = (pick: (v: (typeof rows)[number]['values']) => string | undefined) =>
      new Set(rows.map((r) => pick(r.values)?.trim()).filter(Boolean)).size;
    return {
      kind,
      sheets,
      rows: rows.length,
      importable: plan.valid.length,
      rejected: count(
        plan.errors.flatMap((e) => reasonOf(e.message)),
        (r) => r,
      ).map(({ value, n }) => ({ reason: value, n })),
      noMobile: plan.warnings.length,
      heldSuffix: count(plan.otherSuffix, (r) => `/${r.ajeerCodeFull.split('/')[1] ?? ''}`).map(
        ({ value, n }) => ({ suffix: value, n }),
      ),
      sameCode: plan.sameCode.length,
      zimmedari: zimmedari.map(({ value, n }) => {
        const mapped = ZIMMEDARI_MAP[headerKey(value)];
        return {
          value,
          n,
          mapsTo: mapped
            ? `${mapped.role}${mapped.zimmedari ? ` / ${mapped.zimmedari}` : ''}`
            : null,
        };
      }),
      units: {
        suba: distinct((v) => v.suba),
        division: distinct((v) => v.division),
        district: distinct((v) => v.district),
      },
    };
  }
  const sheets = inspectSheets<VillageColumn>(workbook, VILLAGE_COLUMNS, 'village');
  const rows = readRows<VillageColumn>(workbook, VILLAGE_COLUMNS, 'village');
  const named = rows.filter((r) => r.values.village?.trim());
  return {
    kind,
    sheets,
    rows: rows.length,
    noName: rows.length - named.length,
    withAjeerCode: named.filter((r) => /\d{3,}/.test(r.values.zimmedarCode ?? '')).length,
    withZimmedarNameOnly: named.filter(
      (r) =>
        !/\d{3,}/.test(r.values.zimmedarCode ?? '') &&
        (r.values.zimmedarName?.trim() || r.values.zimmedarCode?.trim()),
    ).length,
    withoutZimmedar: named.filter(
      (r) => !r.values.zimmedarCode?.trim() && !r.values.zimmedarName?.trim(),
    ).length,
    withoutDistrict: named.filter((r) => !r.values.district?.trim()).length,
    districts: count(named, (r) => (r.values.district ?? '').replace(/\s+/g, ' ').trim()),
  };
}
