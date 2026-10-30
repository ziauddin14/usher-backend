// Employee list import (Excel). Real data lives only in backend/private/ (git-ignored).
// Upsert by Ajeer Code; new units are created on the fly; existing passwords are never touched.
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { connectDb } from '../../lib/db.js';
import { normalizeMobile } from '../../lib/mobile.js';
import { Unit, type UnitLevel } from '../../models/unit.js';
import { type Role, User, type Zimmedari } from '../../models/user.js';
import { INITIAL_PASSWORD } from '../auth/schemas.js';
import { BCRYPT_COST } from '../auth/service.js';

/** Columns we read (header text, case and spacing ignored). */
const COLUMNS = {
  ajeerCode: ['ajeercode', 'ajeer', 'code'],
  name: ['naam', 'name'],
  fatherName: ['walid', 'waldiyat', 'fathername', 'father'],
  zimmedari: ['zimmedari', 'role'],
  suba: ['suba', 'province'],
  division: ['division'],
  district: ['district', 'zila'],
  mobile: ['mobile', 'mobileno', 'mobilenumber', 'phone'],
} as const;
type Column = keyof typeof COLUMNS;

const ZIMMEDARI_MAP: Record<string, { role: Role; zimmedari?: Zimmedari }> = {
  ushar: { role: 'zimmedar', zimmedari: 'ushar' },
  usharzimmedar: { role: 'zimmedar', zimmedari: 'ushar' },
  tehsiltown: { role: 'zimmedar', zimmedari: 'tehsil_town' },
  tehsil: { role: 'zimmedar', zimmedari: 'tehsil_town' },
  town: { role: 'zimmedar', zimmedari: 'tehsil_town' },
  event: { role: 'zimmedar', zimmedari: 'event' },
  district: { role: 'district' },
  division: { role: 'division' },
  suba: { role: 'suba' },
};

export interface RawRow {
  row: number;
  values: Partial<Record<Column, string>>;
}

export interface ValidRow {
  row: number;
  ajeerCode: string;
  name: string;
  nameUr?: string;
  fatherName?: string;
  role: Role;
  zimmedari?: Zimmedari;
  suba: string;
  division?: string;
  district?: string;
  mobile?: string;
}

export interface RowProblem {
  row: number;
  ajeerCode?: string;
  message: string;
}

export interface ImportPlan {
  valid: ValidRow[];
  errors: RowProblem[];
  warnings: RowProblem[];
}

export interface ImportResult {
  dryRun: boolean;
  rows: number;
  created: number;
  updated: number;
  newUnits: { code: string; name: string; level: UnitLevel; path: string }[];
  errors: RowProblem[];
  warnings: RowProblem[];
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim() || undefined;
const hasUrduScript = (s: string) => /[؀-ۿ]/.test(s);

/** Read the first worksheet; the first row that names an "Ajeer Code" column is the header. */
export async function readEmployeeSheet(file: string): Promise<RawRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The workbook has no worksheet');

  let header: Map<number, Column> | undefined;
  const rows: RawRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (excelRow, rowNumber) => {
    const texts = new Map<number, string>();
    excelRow.eachCell({ includeEmpty: false }, (cell, col) => {
      texts.set(col, cell.text.trim());
    });
    if (!header) {
      const found = new Map<number, Column>();
      for (const [col, text] of texts) {
        const k = key(text);
        const column = (Object.keys(COLUMNS) as Column[]).find((c) =>
          (COLUMNS[c] as readonly string[]).includes(k),
        );
        if (column) found.set(col, column);
      }
      if ([...found.values()].includes('ajeerCode')) header = found;
      return;
    }
    const values: Partial<Record<Column, string>> = {};
    for (const [col, column] of header) {
      const text = texts.get(col);
      if (text) values[column] = text;
    }
    if (Object.keys(values).length > 0) rows.push({ row: rowNumber, values });
  });
  if (!header) throw new Error('Header row with an "Ajeer Code" column not found');
  return rows;
}

/** Validate rows. Errors skip the row; warnings import it but need attention. */
export function validateRows(rows: RawRow[]): ImportPlan {
  const valid: ValidRow[] = [];
  const errors: RowProblem[] = [];
  const warnings: RowProblem[] = [];
  const seen = new Set<string>();

  for (const { row, values } of rows) {
    const ajeerCode = (values.ajeerCode ?? '').replace(/\s/g, '');
    const problems: string[] = [];
    if (!/^\d{3,9}$/.test(ajeerCode)) problems.push('Ajeer Code must be 3–9 digits');
    else if (seen.has(ajeerCode)) problems.push('Ajeer Code appears twice in the file');

    const name = clean(values.name);
    if (!name) problems.push('Naam is missing');

    const mapped = ZIMMEDARI_MAP[key(values.zimmedari ?? '')];
    if (!mapped) {
      problems.push('Zimmedari must be one of Ushar, Tehsil-Town, Event, District, Division, Suba');
    }

    const suba = clean(values.suba);
    const division = clean(values.division);
    const district = clean(values.district);
    if (!suba) problems.push('Suba is missing');
    if (mapped && mapped.role !== 'suba' && !division) problems.push('Division is missing');
    if (mapped && (mapped.role === 'zimmedar' || mapped.role === 'district') && !district) {
      problems.push('District is missing');
    }

    let mobile: string | undefined;
    if (values.mobile) {
      mobile = normalizeMobile(values.mobile) ?? undefined;
      if (!mobile) problems.push('Mobile is not a valid Pakistani mobile number');
    }

    if (problems.length > 0 || !mapped || !name || !suba) {
      errors.push({ row, ...(ajeerCode ? { ajeerCode } : {}), message: problems.join('; ') });
      continue;
    }
    seen.add(ajeerCode);
    if (!mobile) {
      warnings.push({
        row,
        ajeerCode,
        message: 'No mobile — this user cannot do the first login until a mobile is added',
      });
    }
    valid.push({
      row,
      ajeerCode,
      name,
      ...(hasUrduScript(name) ? { nameUr: name } : {}),
      ...(values.fatherName ? { fatherName: clean(values.fatherName)! } : {}),
      role: mapped.role,
      ...(mapped.zimmedari ? { zimmedari: mapped.zimmedari } : {}),
      suba,
      ...(mapped.role !== 'suba' ? { division: division! } : {}),
      ...(mapped.role === 'zimmedar' || mapped.role === 'district' ? { district: district! } : {}),
      ...(mobile ? { mobile } : {}),
    });
  }
  return { valid, errors, warnings };
}

const LEVEL_WORDS = /\b(suba|province|division|div|district|dist|zila)\b/gi;
const unitKey = (name: string) => key(name.replace(LEVEL_WORDS, ''));

interface UnitRef {
  code: string;
  name: string;
  level: UnitLevel;
  parentCode: string | null;
  path: string;
  isNew: boolean;
}

/** Find units by (parent, name ignoring words like "Division"); plan new ones with unique codes. */
class UnitResolver {
  private byParentAndKey = new Map<string, UnitRef>();
  private codes = new Set<string>();
  readonly created: UnitRef[] = [];

  async load(): Promise<void> {
    const units = await Unit.find().select('code name level parentCode path').lean();
    for (const u of units) {
      const ref: UnitRef = { ...u, parentCode: u.parentCode ?? null, isNew: false };
      this.byParentAndKey.set(`${ref.parentCode ?? ''}|${unitKey(u.name)}`, ref);
      this.codes.add(u.code);
    }
  }

  root(): UnitRef {
    const existing = [...this.byParentAndKey.values()].find((u) => u.level === 'pakistan');
    return existing ?? this.create('Pakistan', 'pakistan', null, 'PK');
  }

  resolve(name: string, level: UnitLevel, parent: UnitRef): UnitRef {
    const found = this.byParentAndKey.get(`${parent.code}|${unitKey(name)}`);
    if (found) return found;
    return this.create(
      name.replace(LEVEL_WORDS, '').replace(/\s+/g, ' ').trim() || name,
      level,
      parent,
    );
  }

  private create(
    name: string,
    level: UnitLevel,
    parent: UnitRef | null,
    fixedCode?: string,
  ): UnitRef {
    const base =
      fixedCode ??
      (name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_|_$/g, '') ||
        'UNIT');
    const suffix = { pakistan: '', suba: '_SUBA', division: '_DIV', district: '_DIST' }[level];
    let code = base;
    if (this.codes.has(code)) code = `${base}${suffix}`;
    for (let n = 2; this.codes.has(code); n += 1) code = `${base}${suffix}_${n}`;
    const ref: UnitRef = {
      code,
      name,
      level,
      parentCode: parent?.code ?? null,
      path: parent ? `${parent.path}/${code}` : code,
      isNew: true,
    };
    this.codes.add(code);
    this.byParentAndKey.set(`${ref.parentCode ?? ''}|${unitKey(name)}`, ref);
    this.created.push(ref);
    return ref;
  }

  /** The unit a user belongs to: their district, or their own unit for supervisors. */
  unitFor(row: ValidRow): UnitRef {
    const suba = this.resolve(row.suba, 'suba', this.root());
    if (row.role === 'suba') return suba;
    const division = this.resolve(row.division!, 'division', suba);
    if (row.role === 'division') return division;
    return this.resolve(row.district!, 'district', division);
  }
}

/** Plan and (unless dryRun) apply the import. */
export async function importEmployees(
  rows: RawRow[],
  { dryRun }: { dryRun: boolean },
): Promise<ImportResult> {
  await connectDb();
  const plan = validateRows(rows);

  const existing = new Map(
    (
      await User.find({ ajeerCode: { $in: plan.valid.map((r) => r.ajeerCode) } })
        .select('ajeerCode isDemo')
        .lean()
    ).map((u) => [u.ajeerCode, u]),
  );

  // Never turn a demo account (known demo password) into a real person's account.
  const toImport: ValidRow[] = [];
  for (const row of plan.valid) {
    if (existing.get(row.ajeerCode)?.isDemo) {
      plan.errors.push({
        row: row.row,
        ajeerCode: row.ajeerCode,
        message: 'This Ajeer Code belongs to a demo user — not imported (ask the CTO)',
      });
    } else {
      toImport.push(row);
    }
  }

  const units = new UnitResolver();
  await units.load();
  const assignments = toImport.map((row) => ({ row, unit: units.unitFor(row) }));

  const result: ImportResult = {
    dryRun,
    rows: rows.length,
    created: assignments.filter((a) => !existing.has(a.row.ajeerCode)).length,
    updated: assignments.filter((a) => existing.has(a.row.ajeerCode)).length,
    newUnits: units.created.map(({ code, name, level, path }) => ({ code, name, level, path })),
    errors: plan.errors.sort((a, b) => a.row - b.row),
    warnings: plan.warnings,
  };
  if (dryRun) return result;

  if (units.created.length > 0) {
    await Unit.insertMany(
      units.created.map(({ code, name, level, parentCode, path }) => ({
        code,
        name,
        level,
        parentCode,
        path,
        isActive: true,
      })),
    );
  }

  const passwordHash = await bcrypt.hash(INITIAL_PASSWORD, BCRYPT_COST);
  if (assignments.length > 0) {
    await User.bulkWrite(
      assignments.map(({ row, unit }) => ({
        updateOne: {
          filter: { ajeerCode: row.ajeerCode },
          update: {
            $set: {
              name: row.name,
              ...(row.nameUr ? { nameUr: row.nameUr } : {}),
              ...(row.fatherName ? { fatherName: row.fatherName } : {}),
              ...(row.mobile ? { mobile: row.mobile } : {}),
              role: row.role,
              ...(row.zimmedari ? { zimmedari: row.zimmedari } : {}),
              unitCode: unit.code,
              unitPath: unit.path,
            },
            ...(row.zimmedari ? {} : { $unset: { zimmedari: '' } }),
            // Only for new users: first password 123 + forced change. Existing passwords stay.
            $setOnInsert: {
              passwordHash,
              mustChangePassword: true,
              isActive: true,
              isDemo: false,
            },
          },
          upsert: true,
        },
      })),
    );
  }
  return result;
}
