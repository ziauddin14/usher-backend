// Registered mobiles from the KPI Excel ("رجسٹرڈ موبائل نمبر"), run AFTER the employee import.
// Only users without a number get one; a number already on record is never overwritten.
// Real data lives only in backend/private/ (git-ignored).
import ExcelJS from 'exceljs';
import { normalizeAjeerCode } from '../../lib/ajeer-code.js';
import { connectDb } from '../../lib/db.js';
import { normalizeMobile } from '../../lib/mobile.js';
import { headerKey, loadWorkbook, readRows, type SheetRow } from '../../lib/xlsx.js';
import { User } from '../../models/user.js';

const COLUMNS = {
  ajeerCode: ['Ajeer Code', 'Ajeer', 'Code', 'ID', 'عملہ کوڈ', 'اجیر کوڈ', 'کوڈ'],
  mobile: [
    'رجسٹرڈ موبائل نمبر',
    'Registered Mobile Number',
    'Registered Mobile',
    'Mobile',
    'Mobile Number',
    'موبائل',
    'موبائل نمبر',
  ],
} as const;
type Column = keyof typeof COLUMNS;
const COLUMN_KEYS = Object.fromEntries(
  Object.entries(COLUMNS).map(([c, names]) => [c, (names as readonly string[]).map(headerKey)]),
) as Record<Column, string[]>;

export type MobileRow = SheetRow<Column>;

export interface MobileProblem {
  row: number;
  ajeerCode?: string;
  mobile?: string;
  message: string;
}

export interface MobileImportResult {
  dryRun: boolean;
  rows: number;
  /** Users who get the number (verified, from the department file). */
  set: { ajeerCode: string; mobile: string }[];
  /** Same number already on record. */
  unchanged: number;
  /** A different number is already on record — not changed. */
  different: { ajeerCode: string; onRecord: string; inFile: string }[];
  problems: MobileProblem[];
  /** Users (non-demo) who still have no number after this import. */
  stillMissing: { ajeerCode: string; name: string; unitCode: string }[];
}

/** Read the first worksheet that has a registered-mobile column. */
export async function readMobileSheet(file: string): Promise<MobileRow[]> {
  return readRows(await loadWorkbook(file), COLUMN_KEYS, 'mobile');
}

export async function importMobiles(
  rows: MobileRow[],
  { dryRun }: { dryRun: boolean },
): Promise<MobileImportResult> {
  await connectDb();
  const problems: MobileProblem[] = [];

  // One number per code; a code with two different numbers in the file is not used.
  const byCode = new Map<string, { row: number; mobile: string }>();
  const twice = new Set<string>();
  for (const { row, values } of rows) {
    const ajeerCode = normalizeAjeerCode(values.ajeerCode);
    const mobile = normalizeMobile(values.mobile);
    if (!ajeerCode) {
      problems.push({ row, message: 'Ajeer Code missing or not a number' });
      continue;
    }
    if (!mobile) {
      if (values.mobile) {
        problems.push({ row, ajeerCode, mobile: values.mobile, message: 'Not a valid mobile' });
      }
      continue;
    }
    const seen = byCode.get(ajeerCode);
    if (seen && seen.mobile !== mobile) {
      twice.add(ajeerCode);
      problems.push({ row, ajeerCode, mobile, message: 'Two different numbers in the file' });
    } else if (!seen) {
      byCode.set(ajeerCode, { row, mobile });
    }
  }
  for (const code of twice) byCode.delete(code);

  const users = await User.find({ ajeerCode: { $in: [...byCode.keys()] }, isDemo: false })
    .select('ajeerCode mobile')
    .lean();
  const userByCode = new Map(users.map((u) => [u.ajeerCode, u]));

  const set: MobileImportResult['set'] = [];
  const different: MobileImportResult['different'] = [];
  let unchanged = 0;
  for (const [ajeerCode, { row, mobile }] of byCode) {
    const user = userByCode.get(ajeerCode);
    if (!user) {
      problems.push({ row, ajeerCode, mobile, message: 'No imported user with this Ajeer Code' });
    } else if (!user.mobile) {
      set.push({ ajeerCode, mobile });
    } else if (user.mobile === mobile) {
      unchanged += 1;
    } else {
      different.push({ ajeerCode, onRecord: user.mobile, inFile: mobile });
    }
  }

  if (!dryRun && set.length > 0) {
    await User.bulkWrite(
      set.map(({ ajeerCode, mobile }) => ({
        updateOne: {
          // Only while still empty, so a number typed meanwhile is never replaced.
          filter: { ajeerCode, mobile: { $exists: false } },
          update: { $set: { mobile, mobileVerified: true } },
        },
      })),
    );
  }

  const setCodes = new Set(set.map((s) => s.ajeerCode));
  const missing = await User.find({ isDemo: false, mobile: { $exists: false } })
    .select('ajeerCode name unitCode')
    .sort({ unitCode: 1, ajeerCode: 1 })
    .lean();
  return {
    dryRun,
    rows: rows.length,
    set,
    unchanged,
    different,
    problems: problems.sort((a, b) => a.row - b.row),
    stillMissing: missing
      .filter((u) => !setCodes.has(u.ajeerCode))
      .map((u) => ({ ajeerCode: u.ajeerCode, name: u.name, unitCode: u.unitCode })),
  };
}

/** Excel report for the CTO (kept in backend/private/, never committed). */
export async function writeMobileReport(result: MobileImportResult, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, columns: string[], rows: (string | number)[][]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(columns).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    ws.columns.forEach((c) => (c.width = 24));
  };
  sheet(
    'Number lage',
    ['Ajeer code', 'Mobile'],
    result.set.map((s) => [s.ajeerCode, s.mobile]),
  );
  sheet(
    'Mukhtalif number',
    ['Ajeer code', 'Pehle se', 'File mein (nahi lagaya)'],
    result.different.map((d) => [d.ajeerCode, d.onRecord, d.inFile]),
  );
  sheet(
    'Masla',
    ['Row', 'Ajeer code', 'Mobile', 'Masla'],
    result.problems.map((p) => [p.row, p.ajeerCode ?? '', p.mobile ?? '', p.message]),
  );
  sheet(
    'Ab bhi bina number',
    ['Ajeer code', 'Naam', 'Unit'],
    result.stillMissing.map((u) => [u.ajeerCode, u.name, u.unitCode]),
  );
  await wb.xlsx.writeFile(file);
}
