// Employee list import (Excel). Real data lives only in backend/private/ (git-ignored).
// Upsert by Ajeer Code; new units are created on the fly; existing passwords are never touched,
// and a mobile already on record is never replaced (differences go to the report, CTO 5 Nov 2026).
import bcrypt from 'bcryptjs';
import { audit } from '../../lib/audit.js';
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
  /** Town / Tehsil of the employee (HR "ٹاؤن"): decides the Tehsil parent of an Ushar Zimmedar. */
  town: ['Town', 'Tehsil/Town', 'Town/Tehsil', 'ٹاؤن', 'تحصیل'],
} as const;
type Column = keyof typeof COLUMNS;
export const COLUMN_KEYS = Object.fromEntries(
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
        // CTO 13 Nov 2026 (user management): a Tehsil/Town Zimmedar does the same field work as an
        // Ushar Zimmedar and reports to the District — a zimmedar, designation "tehsil_town". There
        // is no Tehsil level any more (it replaces the Tehsil role of 9 Nov 2026).
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
        // CTO 9 Nov 2026: "یہ عشر ذمہ دار ہے" — an Ushar Zimmedar, not a Division account.
        ['ڈویژن عشر ذمہ دار', { role: 'zimmedar', zimmedari: 'ushar' }],
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
  /** HR Town / Tehsil, as written. */
  town?: string;
  /**
   * The District written on a Division / Suba official's verified row (and, for a Suba official, the
   * Division too). Used only to create that District unit — never an account (CTO 9 Nov 2026).
   */
  officialDistrict?: { division: string; district: string };
}

/** An eligible employee not imported now (CTO 9 Nov 2026) — listed on its own report sheet. */
export interface HeldEmployee {
  row: number;
  ajeerCode: string;
  /** An Ushar Zimmedar whose District + Town has no importable Tehsil/Town Zimmedar. */
  reason: 'NO_TEHSIL_PARENT';
  /** Verified HR units of the row: they still form the organisation (CTO 9 Nov 2026). */
  suba: string;
  division: string;
  district: string;
  town: string;
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
  /** Rows whose designation (Zimmedari) maps to no role: rejected, listed for confirmation. */
  unknownDesignations: UnknownDesignation[];
  /** Eligible rows not imported now: no verified Tehsil parent. */
  onHold: HeldEmployee[];
}

/** A row whose designation is not mapped to a role — never given one automatically (CTO 7 Nov). */
export interface UnknownDesignation {
  row: number;
  ajeerCode?: string;
  zimmedari: string;
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
  /** Rows whose code ends in something other than "/1": held (never imported) for the CTO. */
  otherSuffix: SameCodeGroup['rows'];
  /** Existing users whose file mobile differs from the one on record — the record is kept. */
  mobileConflicts: { row: number; ajeerCode: string; onRecord: string; inFile: string }[];
  /**
   * Existing accounts whose role, zimmedari or unit the file changes (HR is the source, so the
   * change is applied) — listed so the dry run shows every change of access before the real run.
   */
  changes: { row: number; ajeerCode: string; field: string; from: string; to: string }[];
  /** Designations that map to no role (rows rejected) — the department confirms the mapping. */
  unknownDesignations: UnknownDesignation[];
  /** Not imported now (CTO 9 Nov 2026): no verified Tehsil parent. */
  onHold: HeldEmployee[];
  /** District units that exist only because a Division / Suba official's row names them. */
  officialDistrictUnits: { code: string; name: string; path: string }[];
  /** District values on official rows that are neither an existing unit nor in district-names.csv:
   *  no unit created — listed for confirmation. */
  officialDistrictUnconfirmed: { row: number; suba: string; division: string; district: string }[];
}

/** Who ran an import and from which file (kept on the accounts and in the audit log). */
export interface ImportSource {
  /** File name only — never a folder path. */
  file: string;
  /** The operator who ran it (e.g. "cli:<name>"), recorded as the audit actor. */
  operator: string;
}

/**
 * A code suffix other than /1 ("12345/2", "12345/3"). Since CTO 10 Nov 2026 such a row is imported
 * like any other: the zimmedar logs in with the code before "/" (12345); the full code is kept in
 * `ajeerCodeFull`. The rows are still listed on their own report sheet.
 */
export const OTHER_SUFFIX = /\/(?!1$)/;

/** Same person: the same name, ignoring case and spacing. */
const sameName = (a?: string, b?: string) =>
  !!a &&
  !!b &&
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

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
  const unknownDesignations: UnknownDesignation[] = [];
  const seen = new Set<string>();
  const byCode = new Map<string, SameCodeGroup['rows']>();
  const firstName = new Map<string, string>(); // login code → name on its first row
  const taken = new Set<string>(); // login codes that already have a valid row (one account each)

  for (const { row, values } of rows) {
    const ajeerCode = normalizeAjeerCode(values.ajeerCode) ?? '';
    const ajeerCodeFull = fullAjeerCode(values.ajeerCode) ?? ajeerCode;
    const name = clean(values.name);
    const problems: string[] = [];
    // Rows of one login code ("12345/1" and "12345/2", CTO 10 Nov 2026): the same person (same name)
    // gets one account from the first valid row, the other rows are listed on "Aik code - 1 aur 2";
    // another name on the same code is an error, so two people are never merged into one account.
    let samePerson = false;
    if (!ajeerCode) problems.push('Ajeer Code must be 3–9 digits (optionally followed by /n)');
    else if (seen.has(ajeerCode)) {
      if (!sameName(firstName.get(ajeerCode), name)) {
        problems.push('Ajeer Code appears twice in the file with another name (first row kept)');
      } else samePerson = taken.has(ajeerCode);
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
      if (!firstName.has(ajeerCode) && name) firstName.set(ajeerCode, name);
    }
    if (samePerson) continue; // the same person's account comes from the first valid row

    if (!name) problems.push('Naam is missing');

    const mapped = ZIMMEDARI_MAP[headerKey(values.zimmedari ?? '')];
    if (!mapped) {
      unknownDesignations.push({
        row,
        ...(ajeerCode ? { ajeerCode } : {}),
        zimmedari: clean(values.zimmedari) ?? '',
      });
      problems.push(
        `Zimmedari "${values.zimmedari ?? ''}" is not an approved role (Ushar, Tehsil-Town, Event, District, Division, Suba)`,
      );
    }

    const suba = clean(values.suba);
    const division = clean(values.division);
    const district = clean(values.district);
    if (!suba) problems.push('Suba is missing');
    if (mapped && mapped.role !== 'suba' && !division) problems.push('Division is missing');
    if (
      mapped &&
      (mapped.role === 'zimmedar' || mapped.role === 'tehsil' || mapped.role === 'district') &&
      !district
    ) {
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
    taken.add(ajeerCode);
    if (!mobile) {
      warnings.push({
        row,
        ajeerCode,
        message: 'No mobile in the file (optional — the user may add it in their profile)',
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
      ...(mapped.role === 'zimmedar' || mapped.role === 'tehsil' || mapped.role === 'district'
        ? { district: district! }
        : {}),
      ...(mobile ? { mobile } : {}),
      ...(clean(values.town) ? { town: clean(values.town)! } : {}),
      // A Division / Suba official's own District value (both Division and District present).
      ...((mapped.role === 'division' || mapped.role === 'suba') && division && district
        ? { officialDistrict: { division, district } }
        : {}),
    });
  }
  // No hold any more (CTO 13 Nov 2026): the Tehsil-parent rule of 9 Nov 2026 is gone with the
  // Tehsil level — every Ushar and Tehsil/Town Zimmedar is imported under the District. `onHold`
  // stays in the result (always empty) so older reports keep their shape.
  const onHold: HeldEmployee[] = [];
  const sameCode = [...byCode]
    .filter(([, list]) => list.length > 1)
    .map(([ajeerCode, list]) => ({
      ajeerCode,
      rows: list.map((r) => ({ ...r, imported: valid.some((v) => v.row === r.row) })),
    }));
  const otherSuffix = [...byCode.values()]
    .flat()
    .filter((r) => OTHER_SUFFIX.test(r.ajeerCodeFull))
    .map((r) => ({ ...r, imported: valid.some((v) => v.row === r.row) }))
    .sort((a, b) => a.row - b.row);
  // Warnings of held rows belong to rows that are not imported now.
  const heldRows = new Set(onHold.map((h) => h.row));
  const importWarnings = warnings.filter((w) => !heldRows.has(w.row));
  return {
    valid,
    errors,
    warnings: importWarnings,
    sameCode,
    otherSuffix,
    unknownDesignations,
    onHold,
  };
}

/**
 * For the village import: codes the employee import rejects and employees on hold (no verified
 * Tehsil parent, CTO 9 Nov 2026); villages naming them are never assigned. `held` is empty since
 * CTO 10 Nov 2026: /2 and /3 codes are imported with the code before "/" (kept for the API shape).
 */
export function hrCodesFromPlan(plan: ImportPlan): {
  held: Set<string>;
  rejected: Set<string>;
  onHold: Set<string>;
  /** HR District of each employee on hold — the village import still applies "District farq". */
  districtOf: Map<string, string>;
} {
  const held = new Set<string>();
  const imported = new Set(plan.valid.map((v) => v.ajeerCode));
  const onHold = new Set(
    plan.onHold.map((h) => h.ajeerCode).filter((c) => !imported.has(c) && !held.has(c)),
  );
  const rejected = new Set(
    plan.errors
      .map((e) => e.ajeerCode)
      .filter((c): c is string => !!c && !imported.has(c) && !held.has(c) && !onHold.has(c)),
  );
  const districtOf = new Map(
    plan.onHold.filter((h) => onHold.has(h.ajeerCode)).map((h) => [h.ajeerCode, h.district]),
  );
  return { held, rejected, onHold, districtOf };
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

/**
 * Comparison key of a unit name at a level. Suba / Division / District ignore level words
 * ("Multan Division" = "ملتان"); a Tehsil is matched exactly as HR writes the Town (only case,
 * spaces and punctuation ignored), so "X ٹاؤن" and "X تحصیل" never merge (CTO 9 Nov 2026).
 */
const unitNameKey = (level: UnitLevel, name: string) =>
  level === 'tehsil' ? `tehsil:${headerKey(name)}` : unitKey(name);

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
        if (n) this.byParentAndKey.set(`${ref.parentCode ?? ''}|${unitNameKey(u.level, n)}`, ref);
      }
      this.codes.add(u.code);
    }
  }

  root(): UnitRef {
    // The national unit by its code: a test sandbox root (TEST, 13 Nov 2026) is never the root.
    const existing = [...this.byParentAndKey.values()].find(
      (u) => u.level === 'pakistan' && u.code === 'PK',
    );
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
      const found = n && this.byParentAndKey.get(`${parent.code}|${unitNameKey(level, n)}`);
      if (found) return found;
    }
    const bare =
      level === 'tehsil'
        ? name.replace(/\s+/g, ' ').trim()
        : name.replace(LEVEL_WORDS, '').replace(/\s+/g, ' ').trim() || name;
    return this.create(roman ?? bare, level, parent, undefined, roman ? bare : undefined);
  }

  /**
   * True when the unit already exists, or its name (with its Urdu chain) is in the verified
   * district-names.csv — i.e. creating it is not a guess from an unconfirmed name.
   */
  isConfirmed(name: string, level: UnitLevel, parent: UnitRef, urduChain: string[]): boolean {
    const roman = hasUrduScript(name) ? this.names?.romanFor(level, urduChain) : undefined;
    if (roman) return true;
    return this.byParentAndKey.has(`${parent.code}|${unitNameKey(level, name)}`);
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
    const suffix = {
      pakistan: '',
      suba: '_SUBA',
      division: '_DIV',
      district: '_DIST',
      tehsil: '_TEH',
    }[level];
    let code: string;
    if (latin) {
      code = latin;
      if (this.codes.has(code)) code = `${latin}${suffix}`;
      for (let n = 2; this.codes.has(code); n += 1) code = `${latin}${suffix}_${n}`;
    } else {
      // Urdu-only name: a neutral code such as DIST_3 (the name is kept in name / nameUr).
      const prefix = {
        pakistan: 'PK',
        suba: 'SUBA',
        division: 'DIV',
        district: 'DIST',
        tehsil: 'TEH',
      }[level];
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
      if (n) this.byParentAndKey.set(`${ref.parentCode ?? ''}|${unitNameKey(level, n)}`, ref);
    }
    this.created.push(ref);
    return ref;
  }

  /**
   * The unit a user belongs to: a supervisor's own unit; every zimmedar (Ushar, Tehsil/Town, Event)
   * the District — no Tehsil unit is ever created (CTO 13 Nov 2026).
   */
  unitFor(row: ValidRow): UnitRef {
    const suba = this.resolve(row.suba, 'suba', this.root(), [row.suba]);
    if (row.role === 'suba') return suba;
    const division = this.resolve(row.division!, 'division', suba, [row.suba, row.division!]);
    if (row.role === 'division') return division;
    const district = this.resolve(row.district!, 'district', division, [
      row.suba,
      row.division!,
      row.district!,
    ]);
    return district;
  }
}

/** Plan and (unless dryRun) apply the import. New units get Roman names from district-names.csv. */
export async function importEmployees(
  rows: RawRow[],
  {
    dryRun,
    names = DistrictNames.load(),
    source,
  }: { dryRun: boolean; names?: DistrictNames; source?: ImportSource },
): Promise<ImportResult> {
  await connectDb();
  const plan = validateRows(rows);
  const startedAt = new Date();

  const existing = new Map(
    (
      await User.find({ ajeerCode: { $in: plan.valid.map((r) => r.ajeerCode) } })
        .select('ajeerCode isDemo mobile role zimmedari unitCode department provisioned')
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
  // Units of held rows too: verified HR organisation, created without any account (CTO 9 Nov 2026).
  for (const h of plan.onHold) {
    units.unitFor({
      ...h,
      ajeerCodeFull: h.ajeerCode,
      name: '',
      role: 'zimmedar',
      town: undefined, // up to the District only: a Town without a verified Tehsil is no unit
    });
  }
  // District units written on authorized Division / Suba officials' verified rows (CTO 9 Nov 2026):
  // the District unit exists even when no District-level employee does; nobody is made its
  // responsible person. A Suba row needs its Division as well, else nothing is created.
  const beforeOfficial = units.created.length;
  const officialUnconfirmed: ImportResult['officialDistrictUnconfirmed'] = [];
  for (const row of toImport) {
    if (!row.officialDistrict) continue;
    const { division: div, district: dist } = row.officialDistrict;
    const subaRef = units.resolve(row.suba, 'suba', units.root(), [row.suba]);
    const divRef = units.resolve(div, 'division', subaRef, [row.suba, div]);
    // Only a confirmed name: an existing unit or one listed in district-names.csv.
    if (!units.isConfirmed(dist, 'district', divRef, [row.suba, div, dist])) {
      officialUnconfirmed.push({ row: row.row, suba: row.suba, division: div, district: dist });
      continue;
    }
    units.unitFor({
      ...row,
      role: 'zimmedar',
      division: row.officialDistrict.division,
      district: row.officialDistrict.district,
      town: undefined, // District only — an official record never creates a Tehsil
    });
  }
  const officialDistrictUnits = units.created
    .slice(beforeOfficial)
    .filter((u) => u.level === 'district')
    .map(({ code, name, path }) => ({ code, name, path }));
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

  const changes: ImportResult['changes'] = [];
  for (const { row, unit } of assignments) {
    const known = existing.get(row.ajeerCode);
    if (!known) continue;
    const compare: [string, string | null | undefined, string | undefined][] = [
      ['role', known.role, row.role],
      ['zimmedari', known.zimmedari, row.zimmedari],
      ['unit', known.unitCode, unit.code],
    ];
    for (const [field, from, to] of compare) {
      if ((from ?? '') !== (to ?? '')) {
        changes.push({
          row: row.row,
          ajeerCode: row.ajeerCode,
          field,
          from: from ?? '',
          to: to ?? '',
        });
      }
    }
  }

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
    unknownDesignations: plan.unknownDesignations,
    onHold: plan.onHold,
    officialDistrictUnits,
    officialDistrictUnconfirmed: officialUnconfirmed,
    mobileConflicts,
    changes,
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
              hrImport: {
                ...(source ? { file: source.file } : {}),
                row: row.row,
                at: startedAt,
              },
            },
            // Never touched here: password, mustChangePassword (except for a new account),
            // isActive, a mobile on record, department.
            ...(row.zimmedari ? {} : { $unset: { zimmedari: '' } }),
            // Only for new users: first password (INITIAL_PASSWORD) + forced change. Existing passwords stay.
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
            update: { $set: { mobile: row.mobile } },
          },
        })),
      );
    }
  }
  // One audit entry per real run: counts only — no names, mobiles or passwords.
  await audit({
    action: 'IMPORT_EMPLOYEES',
    actorAjeerCode: source?.operator ?? 'import',
    targetType: 'import',
    details: {
      ...(source ? { file: source.file } : {}),
      rows: result.rows,
      created: result.created,
      updated: result.updated,
      newUnits: result.newUnits.length,
      rejected: result.errors.length,
      changes: result.changes.length,
      noTehsilParent: result.onHold.filter((h) => h.reason === 'NO_TEHSIL_PARENT').length,
      mobileConflicts: result.mobileConflicts.length,
    },
  });
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
    'Code 2, 3 - login pehla code',
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
  sheet(
    'Tabdeeliyan',
    ['Row', 'Ajeer code', 'Kya badla', 'Pehle', 'Ab'],
    result.changes.map((c) => [c.row, c.ajeerCode, c.field, c.from, c.to]),
  );
  // Mapping table for the department to fill in (no role is assigned automatically).
  const byDesignation = new Map<string, number>();
  for (const d of result.unknownDesignations) {
    byDesignation.set(d.zimmedari, (byDesignation.get(d.zimmedari) ?? 0) + 1);
  }
  const heldSheet = (name: string, reason: HeldEmployee['reason']) =>
    sheet(
      name,
      ['Row', 'Ajeer code', 'District', 'Town / Tehsil'],
      result.onHold
        .filter((h) => h.reason === reason)
        .map((h) => [h.row, h.ajeerCode, h.district, h.town]),
    );
  sheet(
    'District - tasdeeq baqi',
    ['Row', 'Suba', 'Division', 'District (official record)'],
    result.officialDistrictUnconfirmed.map((u) => [u.row, u.suba, u.division, u.district]),
  );
  sheet(
    'District - official record',
    ['District', 'Path', 'Responsible account'],
    result.officialDistrictUnits.map((u) => [u.name, u.path, '(none — blank)']),
  );
  heldSheet('Tehsil parent nahi', 'NO_TEHSIL_PARENT');
  sheet(
    'Designation - tasdeeq',
    ['Designation (file)', 'Rows', 'Role (department to confirm)', 'Notes'],
    [...byDesignation].sort((x, y) => y[1] - x[1]).map(([z, n]) => [z, n, '', '']),
  );
  sheet(
    'Designation rows',
    ['Row', 'Ajeer code', 'Designation'],
    result.unknownDesignations.map((d) => [d.row, d.ajeerCode ?? '', d.zimmedari]),
  );
  await wb.xlsx.writeFile(file);
}
