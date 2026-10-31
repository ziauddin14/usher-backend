// Employee list import (Excel). Real data lives only in backend/private/ (git-ignored).
// Upsert by Ajeer Code; new units are created on the fly; existing passwords are never touched.
import bcrypt from 'bcryptjs';
import { connectDb } from '../../lib/db.js';
import { normalizeAjeerCode } from '../../lib/ajeer-code.js';
import { normalizeMobile } from '../../lib/mobile.js';
import { LEVEL_WORDS, unitKey } from '../../lib/unit-name.js';
import { headerKey, loadWorkbook, readRows } from '../../lib/xlsx.js';
import { Unit, type UnitLevel } from '../../models/unit.js';
import { type Role, User, type Zimmedari } from '../../models/user.js';
import { INITIAL_PASSWORD } from '../auth/schemas.js';
import { BCRYPT_COST } from '../auth/service.js';

/**
 * Columns we read. Header text is compared with headerKey() (case, spaces and punctuation
 * ignored). English names from the spec + the Urdu headers of the department export.
 */
const COLUMNS = {
  ajeerCode: ['Ajeer Code', 'Ajeer', 'Code', 'عملہ کوڈ', 'اجیر کوڈ'],
  name: ['Naam', 'Name', 'نام'],
  fatherName: ['Walid', 'Waldiyat', 'Father Name', 'Father', 'ولدیت', 'والد'],
  zimmedari: ['Zimmedari', 'Role', 'ذمہ داری'],
  suba: ['Suba', 'Province', 'صوبائی/انتظامی اکائی', 'صوبہ'],
  division: ['Division', 'سرکاری ڈویژن', 'ڈویژن'],
  district: ['District', 'Zila', 'ڈسٹرکٹ', 'ضلع'],
  mobile: ['Mobile', 'Mobile No', 'Mobile Number', 'Phone', 'موبائل', 'موبائل نمبر'],
} as const;
type Column = keyof typeof COLUMNS;
const COLUMN_KEYS = Object.fromEntries(
  Object.entries(COLUMNS).map(([c, names]) => [c, (names as readonly string[]).map(headerKey)]),
) as Record<Column, string[]>;

/**
 * Zimmedari text → role. English values from the spec; Urdu values seen in the department
 * export. Rows with any other value are rejected and listed in the report (ask the CTO).
 */
const ZIMMEDARI_MAP: Record<string, { role: Role; zimmedari?: Zimmedari }> = Object.fromEntries(
  (
    [
      ['Ushar', { role: 'zimmedar', zimmedari: 'ushar' }],
      ['Ushar Zimmedar', { role: 'zimmedar', zimmedari: 'ushar' }],
      ['Tehsil-Town', { role: 'zimmedar', zimmedari: 'tehsil_town' }],
      ['Tehsil', { role: 'zimmedar', zimmedari: 'tehsil_town' }],
      ['Town', { role: 'zimmedar', zimmedari: 'tehsil_town' }],
      ['Event', { role: 'zimmedar', zimmedari: 'event' }],
      ['District', { role: 'district' }],
      ['Division', { role: 'division' }],
      ['Suba', { role: 'suba' }],
      ['اسسٹینٹ عشر ذمہ دار', { role: 'zimmedar', zimmedari: 'ushar' }],
      ['عشر ذمہ دار', { role: 'zimmedar', zimmedari: 'ushar' }],
      ['ٹاؤن /تحصیل ذمہ دار', { role: 'zimmedar', zimmedari: 'tehsil_town' }],
      ['ایونٹ عشر ذمہ دار', { role: 'zimmedar', zimmedari: 'event' }],
      ['ڈسٹرکٹ ذمہ دار', { role: 'district' }],
      ['سرکاری ڈویژن ذمہ دار', { role: 'division' }],
      ['ڈویژن عشر ذمہ دار', { role: 'division' }],
      ['صوبائی ذمہ دار', { role: 'suba' }],
    ] as const
  ).map(([text, mapped]) => [headerKey(text), mapped]),
);

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

const clean = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim() || undefined;
const hasUrduScript = (s: string) => /[؀-ۿ]/.test(s);

/** Read the first worksheet that has an "Ajeer Code" column (title rows above it are skipped). */
export async function readEmployeeSheet(file: string): Promise<RawRow[]> {
  return readRows(await loadWorkbook(file), COLUMN_KEYS, 'ajeerCode');
}

/** Validate rows. Errors skip the row; warnings import it but need attention. */
export function validateRows(rows: RawRow[]): ImportPlan {
  const valid: ValidRow[] = [];
  const errors: RowProblem[] = [];
  const warnings: RowProblem[] = [];
  const seen = new Set<string>();

  for (const { row, values } of rows) {
    const ajeerCode = normalizeAjeerCode(values.ajeerCode) ?? '';
    const problems: string[] = [];
    if (!ajeerCode) problems.push('Ajeer Code must be 3–9 digits (optionally followed by /n)');
    else if (seen.has(ajeerCode)) problems.push('Ajeer Code appears twice in the file');

    const name = clean(values.name);
    if (!name) problems.push('Naam is missing');

    const mapped = ZIMMEDARI_MAP[headerKey(values.zimmedari ?? '')];
    if (!mapped) {
      problems.push(
        `Zimmedari "${values.zimmedari ?? ''}" is not a Demo v1 role (Ushar, Tehsil-Town, Event, District, Division, Suba)`,
      );
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
      if (ajeerCode) seen.add(ajeerCode);
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

interface UnitRef {
  code: string;
  name: string;
  nameUr?: string | null;
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
    const units = await Unit.find().select('code name nameUr level parentCode path').lean();
    for (const u of units) {
      const ref: UnitRef = { ...u, parentCode: u.parentCode ?? null, isNew: false };
      // Match by the Roman and the Urdu name (the department export uses Urdu names).
      for (const n of [u.name, u.nameUr]) {
        if (n) this.byParentAndKey.set(`${ref.parentCode ?? ''}|${unitKey(n)}`, ref);
      }
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
    const latin =
      fixedCode ??
      name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
    const suffix = { pakistan: '', suba: '_SUBA', division: '_DIV', district: '_DIST' }[level];
    let code: string;
    if (latin) {
      code = latin;
      if (this.codes.has(code)) code = `${latin}${suffix}`;
      for (let n = 2; this.codes.has(code); n += 1) code = `${latin}${suffix}_${n}`;
    } else {
      // Urdu-only name: a neutral code such as DIST_3 (the name is kept in name / nameUr).
      const prefix = { pakistan: 'PK', suba: 'SUBA', division: 'DIV', district: 'DIST' }[level];
      let n = 1;
      while (this.codes.has(`${prefix}_${n}`)) n += 1;
      code = `${prefix}_${n}`;
    }
    const ref: UnitRef = {
      code,
      name,
      ...(/[\u0600-\u06FF]/.test(name) ? { nameUr: name } : {}),
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
      units.created.map(({ code, name, nameUr, level, parentCode, path }) => ({
        code,
        name,
        ...(nameUr ? { nameUr } : {}),
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
