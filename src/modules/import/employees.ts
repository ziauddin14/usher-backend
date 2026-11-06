// Employee list import (Excel). Real data lives only in backend/private/ (git-ignored).
// Upsert by Ajeer Code; new units are created on the fly; existing passwords are never touched,
// and a mobile already on record is never replaced (differences go to the report, CTO 5 Nov 2026).
import bcrypt from 'bcryptjs';
import { connectDb } from '../../lib/db.js';
import { DistrictNames } from '../../lib/district-names.js';
import ExcelJS from 'exceljs';
import { fullAjeerCode, normalizeAjeerCode } from '../../lib/ajeer-code.js';
import { normalizeMobile } from '../../lib/mobile.js';
import { LEVEL_WORDS, unitKey } from '../../lib/unit-name.js';
import { headerKey, loadWorkbook, readRows } from '../../lib/xlsx.js';
import { Unit, type UnitLevel } from '../../models/unit.js';
import {
  isCentrallyManaged,
  NOT_CENTRALLY_MANAGED,
  type Role,
  User,
  type Zimmedari,
} from '../../models/user.js';
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
 * No value ever maps to 'pakistan' (CTO 6 Nov 2026): a Pakistan Admin account exists only through
 * Central IT's controlled provisioning (scripts/provision-pakistan-admin.ts), never through an
 * import — a matching designation or employee record grants nothing.
 */
export const ZIMMEDARI_MAP: Record<string, { role: Role; zimmedari?: Zimmedari }> =
  Object.fromEntries(
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
  /** As written in the file, e.g. "12345/1". */
  ajeerCodeFull: string;
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

/** One login code that appears on more than one row (e.g. "12345/1" and "12345/2"). */
export interface SameCodeGroup {
  ajeerCode: string;
  rows: {
    row: number;
    ajeerCodeFull: string;
    name: string;
    zimmedari: string;
    district: string;
    imported?: boolean;
  }[];
}

export interface ImportPlan {
  valid: ValidRow[];
  errors: RowProblem[];
  warnings: RowProblem[];
  sameCode: SameCodeGroup[];
  /** Rows whose code ends in something other than "/1" ("12345/2", "12345/3"). */
  otherSuffix: SameCodeGroup['rows'];
}

export interface ImportResult {
  dryRun: boolean;
  rows: number;
  created: number;
  updated: number;
  newUnits: { code: string; name: string; level: UnitLevel; path: string }[];
  errors: RowProblem[];
  warnings: RowProblem[];
  /** Codes on more than one row: the first row is imported, the others are rejected. */
  sameCode: SameCodeGroup[];
  /** Rows whose code ends in something other than "/1" — listed for the CTO. */
  otherSuffix: SameCodeGroup['rows'];
  /** Existing users whose file mobile differs from the one on record — the record is kept. */
  mobileConflicts: { row: number; ajeerCode: string; onRecord: string; inFile: string }[];
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
  const byCode = new Map<string, SameCodeGroup['rows']>();

  for (const { row, values } of rows) {
    const ajeerCode = normalizeAjeerCode(values.ajeerCode) ?? '';
    const ajeerCodeFull = fullAjeerCode(values.ajeerCode) ?? ajeerCode;
    const problems: string[] = [];
    if (!ajeerCode) problems.push('Ajeer Code must be 3–9 digits (optionally followed by /n)');
    else if (seen.has(ajeerCode)) {
      problems.push(
        `Ajeer Code appears twice in the file (login code ${ajeerCode}; first row kept)`,
      );
    }
    if (ajeerCode) {
      const group = byCode.get(ajeerCode) ?? [];
      group.push({
        row,
        ajeerCodeFull,
        name: clean(values.name) ?? '',
        zimmedari: clean(values.zimmedari) ?? '',
        district: clean(values.district) ?? '',
      });
      byCode.set(ajeerCode, group);
    }

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
      ajeerCodeFull,
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
  const sameCode = [...byCode]
    .filter(([, list]) => list.length > 1)
    .map(([ajeerCode, list]) => ({
      ajeerCode,
      rows: list.map((r) => ({ ...r, imported: valid.some((v) => v.row === r.row) })),
    }));
  const otherSuffix = [...byCode.values()]
    .flat()
    .filter((r) => /\/(?!1$)/.test(r.ajeerCodeFull))
    .map((r) => ({ ...r, imported: valid.some((v) => v.row === r.row) }))
    .sort((a, b) => a.row - b.row);
  return { valid, errors, warnings, sameCode, otherSuffix };
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

  constructor(private readonly names?: DistrictNames) {}

  /**
   * Find the unit under `parent` by its name (or by its Roman name from district-names.csv);
   * otherwise plan a new one. `urduChain` = the Urdu names from the suba down to this unit.
   */
  resolve(name: string, level: UnitLevel, parent: UnitRef, urduChain: string[]): UnitRef {
    const roman = hasUrduScript(name) ? this.names?.romanFor(level, urduChain) : undefined;
    for (const n of [name, roman]) {
      const found = n && this.byParentAndKey.get(`${parent.code}|${unitKey(n)}`);
      if (found) return found;
    }
    const bare = name.replace(LEVEL_WORDS, '').replace(/\s+/g, ' ').trim() || name;
    return this.create(roman ?? bare, level, parent, undefined, roman ? bare : undefined);
  }

  private create(
    name: string,
    level: UnitLevel,
    parent: UnitRef | null,
    fixedCode?: string,
    urduName?: string,
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
      ...(urduName ? { nameUr: urduName } : /[\u0600-\u06FF]/.test(name) ? { nameUr: name } : {}),
      level,
      parentCode: parent?.code ?? null,
      path: parent ? `${parent.path}/${code}` : code,
      isNew: true,
    };
    this.codes.add(code);
    for (const n of [name, urduName]) {
      if (n) this.byParentAndKey.set(`${ref.parentCode ?? ''}|${unitKey(n)}`, ref);
    }
    this.created.push(ref);
    return ref;
  }

  /** The unit a user belongs to: their district, or their own unit for supervisors. */
  unitFor(row: ValidRow): UnitRef {
    const suba = this.resolve(row.suba, 'suba', this.root(), [row.suba]);
    if (row.role === 'suba') return suba;
    const division = this.resolve(row.division!, 'division', suba, [row.suba, row.division!]);
    if (row.role === 'division') return division;
    return this.resolve(row.district!, 'district', division, [
      row.suba,
      row.division!,
      row.district!,
    ]);
  }
}

/** Plan and (unless dryRun) apply the import. New units get Roman names from district-names.csv. */
export async function importEmployees(
  rows: RawRow[],
  { dryRun, names = DistrictNames.load() }: { dryRun: boolean; names?: DistrictNames },
): Promise<ImportResult> {
  await connectDb();
  const plan = validateRows(rows);

  const existing = new Map(
    (
      await User.find({ ajeerCode: { $in: plan.valid.map((r) => r.ajeerCode) } })
        .select('ajeerCode isDemo mobile role department provisioned')
        .lean()
    ).map((u) => [u.ajeerCode, u]),
  );

  // Never turn a demo account (known demo password) into a real person's account, and never
  // change a pakistan-level / centrally provisioned account (CTO 6 Nov 2026: only Central IT's
  // controlled provisioning creates or changes those — an import never creates, promotes or
  // demotes one, whatever its row says).
  const toImport: ValidRow[] = [];
  for (const row of plan.valid) {
    const known = existing.get(row.ajeerCode);
    if (known && isCentrallyManaged(known)) {
      plan.errors.push({
        row: row.row,
        ajeerCode: row.ajeerCode,
        message:
          'This Ajeer Code is a centrally provisioned Pakistan Admin account — never changed by an import',
      });
    } else if (known?.isDemo) {
      plan.errors.push({
        row: row.row,
        ajeerCode: row.ajeerCode,
        message: 'This Ajeer Code belongs to a demo user — not imported (ask the CTO)',
      });
    } else {
      toImport.push(row);
    }
  }

  const units = new UnitResolver(names);
  await units.load();
  const assignments = toImport.map((row) => ({ row, unit: units.unitFor(row) }));
  // A number already on record (from an earlier import, the KPI file or typed by the user) is
  // never overwritten; only users without one get the file's number.
  const mobileConflicts: ImportResult['mobileConflicts'] = [];
  for (const { row } of assignments) {
    const onRecord = existing.get(row.ajeerCode)?.mobile;
    if (onRecord && row.mobile && onRecord !== row.mobile) {
      mobileConflicts.push({
        row: row.row,
        ajeerCode: row.ajeerCode,
        onRecord,
        inFile: row.mobile,
      });
    }
  }
  const fillsMobile = (row: ValidRow) => !!row.mobile && !existing.get(row.ajeerCode)?.mobile;

  const result: ImportResult = {
    dryRun,
    rows: rows.length,
    created: assignments.filter((a) => !existing.has(a.row.ajeerCode)).length,
    updated: assignments.filter((a) => existing.has(a.row.ajeerCode)).length,
    newUnits: units.created.map(({ code, name, level, path }) => ({ code, name, level, path })),
    errors: plan.errors.sort((a, b) => a.row - b.row),
    warnings: plan.warnings,
    sameCode: plan.sameCode,
    otherSuffix: plan.otherSuffix,
    mobileConflicts,
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
          // The database itself never matches a centrally managed (Pakistan Admin) account, even one
          // provisioned after the check above: the upsert then hits the unique ajeer code and the
          // import stops with an error instead of changing that account.
          filter: { ajeerCode: row.ajeerCode, ...NOT_CENTRALLY_MANAGED },
          update: {
            $set: {
              name: row.name,
              ajeerCodeFull: row.ajeerCodeFull,
              ...(row.nameUr ? { nameUr: row.nameUr } : {}),
              ...(row.fatherName ? { fatherName: row.fatherName } : {}),
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
    // Only users without a number get the file's number — the filter makes sure a number saved
    // meanwhile (e.g. typed at a first login during the import) is never replaced.
    const fills = assignments.filter(({ row }) => fillsMobile(row));
    if (fills.length > 0) {
      await User.bulkWrite(
        fills.map(({ row }) => ({
          updateOne: {
            filter: {
              ajeerCode: row.ajeerCode,
              mobile: { $exists: false },
              ...NOT_CENTRALLY_MANAGED,
            },
            update: { $set: { mobile: row.mobile, mobileVerified: true } },
          },
        })),
      );
    }
  }
  return result;
}

/** Excel report for the CTO (kept in backend/private/, never committed). */
export async function writeEmployeeReport(result: ImportResult, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, columns: string[], rows: (string | number)[][]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(columns).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    ws.columns.forEach((c) => (c.width = 24));
  };
  sheet(
    'Import nahi hue',
    ['Row', 'Ajeer code', 'Masla'],
    result.errors.map((e) => [e.row, e.ajeerCode ?? '', e.message]),
  );
  sheet(
    'Tawajjuh',
    ['Row', 'Ajeer code', 'Baat'],
    result.warnings.map((w) => [w.row, w.ajeerCode ?? '', w.message]),
  );
  sheet(
    'Aik code - 1 aur 2',
    ['Login code', 'Row', 'Poora code', 'Naam', 'Zimmedari', 'District', 'Import hua?'],
    result.sameCode.flatMap((g) =>
      g.rows.map((r) => [
        g.ajeerCode,
        r.row,
        r.ajeerCodeFull,
        r.name,
        r.zimmedari,
        r.district,
        r.imported ? 'haan' : 'nahi',
      ]),
    ),
  );
  sheet(
    'Code 2, 3',
    ['Row', 'Poora code', 'Naam', 'Zimmedari', 'District', 'Import hua?'],
    result.otherSuffix.map((r) => [
      r.row,
      r.ajeerCodeFull,
      r.name,
      r.zimmedari,
      r.district,
      r.imported ? 'haan' : 'nahi',
    ]),
  );
  sheet(
    'Mobile farq',
    ['Row', 'Ajeer code', 'Record wala number (rakha gaya)', 'File wala number'],
    result.mobileConflicts.map((c) => [c.row, c.ajeerCode, c.onRecord, c.inFile]),
  );
  sheet(
    'Naye units',
    ['Level', 'Naam', 'Path'],
    result.newUnits.map((u) => [u.level, u.name, u.path]),
  );
  await wb.xlsx.writeFile(file);
}
