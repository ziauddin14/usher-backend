// Village list import (Excel) — run AFTER the employee import. Real data stays in backend/private/.
// Each village gets status "approved" and is assigned to its Ushar Zimmedar (assignedTo) unless
// somebody is already responsible for it (an import never undoes the District's assignment).
import ExcelJS from 'exceljs';
import { type AnyBulkWriteOperation, Types } from 'mongoose';
import { fullAjeerCode, normalizeAjeerCode } from '../../lib/ajeer-code.js';
import { audit } from '../../lib/audit.js';
import { connectDb } from '../../lib/db.js';
import { DistrictNames } from '../../lib/district-names.js';
import { districtPathOf } from '../../lib/scope.js';
import { villageNameKey } from '../../lib/text.js';
import { unitKey } from '../../lib/unit-name.js';
import { headerKey, loadWorkbook, readRows } from '../../lib/xlsx.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village, type VillageDoc } from '../../models/village.js';

/** Spec headers + the department export (Sheet1 of the village list). */
const COLUMNS = {
  village: ['Gaon ka naam', 'Gaon', 'Village', 'Village Name', 'گاؤں کا نام', 'گاؤں'],
  tehsil: ['Tehsil', 'Town', 'تحصیل', 'ٹاؤن'],
  district: ['District', 'Zila', 'ڈسٹرکٹ', 'ضلع'],
  zimmedarCode: [
    'Zimmedar Ajeer Code',
    'Ajeer Code',
    'Zimmedar ID',
    'ID',
    'Login Id',
    'Employee Code',
    'اجیر کوڈ',
    'عملہ کوڈ',
  ],
  zimmedarName: [
    'Zimmedar',
    'Zimmedar Naam',
    'Zimmedar Name',
    'User Name',
    'Ushar Zimmedar',
    'Usher Zimmedar Name',
    'عشر ذمہ دار',
  ],
} as const;
type Column = keyof typeof COLUMNS;
export const COLUMN_KEYS = Object.fromEntries(
  Object.entries(COLUMNS).map(([c, names]) => [c, (names as readonly string[]).map(headerKey)]),
) as Record<Column, string[]>;

export interface VillageRow {
  row: number;
  values: Partial<Record<Column, string>>;
}

export async function readVillageSheet(file: string): Promise<VillageRow[]> {
  return readRows(await loadWorkbook(file), COLUMN_KEYS, 'village');
}

export interface UnmatchedRow {
  row: number;
  village: string;
  tehsil: string;
  district: string;
  zimmedar: string;
  /** "Usher Zimmedar Name" as written in the file — a reference only, never matched. */
  zimmedarName: string;
  problem: string;
}

export interface Conflict {
  village: string;
  district: string;
  zimmedaran: string;
  chosen: string;
}

export interface VillageImportResult {
  dryRun: boolean;
  rows: number;
  /** Distinct villages (district + normalized name) found in the file. */
  villages: number;
  duplicateRows: number;
  created: number;
  updated: number;
  assigned: number;
  /** Villages not imported because their district could not be found. */
  unmatchedVillages: UnmatchedRow[];
  /** Rows without a village name (not imported). */
  noName: UnmatchedRow[];
  /**
   * Villages listed under a District / Division (or other supervisor) user: imported with no
   * zimmedar ("district pool"). No zimmedar sees or uses them until the District assigns them
   * (CTO 7 Nov 2026: a zimmedar sees only assigned villages).
   */
  districtPool: UnmatchedRow[];
  /** Villages imported without a zimmedar, because the zimmedar could not be matched. */
  unmatchedZimmedar: UnmatchedRow[];
  conflicts: Conflict[];
  /**
   * Villages already given to a zimmedar (by an earlier import or by the District) whom the file
   * names differently: the current assignment is kept — an import never undoes the District.
   */
  assignmentKept: { village: string; district: string; current: string; inFile: string }[];
  /** File names that matched a village under an earlier spelling (renamed or merged). */
  formerNameMatches: { inFile: string; district: string; village: string }[];
  /** Rows naming an Ajeer Code the HR file holds back (/2, /3 …): never assigned (CTO 7 Nov). */
  heldCode: UnmatchedRow[];
  /** Rows naming an employee the HR import rejected (e.g. designation not confirmed). */
  notImportedEmployee: UnmatchedRow[];
  /** Rows naming an employee on hold (no verified Tehsil parent): never assigned. */
  employeeOnHold: UnmatchedRow[];
  /** Rows whose District differs from the named employee's own district: not imported. */
  districtMismatch: UnmatchedRow[];
}

/** From the HR file: codes held back (/2, /3 …) and codes the employee import rejected. */
export interface HrCodes {
  held: Set<string>;
  rejected: Set<string>;
  /** Employees not imported now: no verified Tehsil parent (CTO 9 Nov 2026). */
  onHold?: Set<string>;
  /** HR District (as written) of each employee on hold. */
  districtOf?: Map<string, string>;
}

/** Who ran an import and from which file (kept on new villages and in the audit log). */
export interface VillageImportSource {
  /** File name only — never a folder path. */
  file: string;
  operator: string;
}

const clean = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim() ?? '';

interface Group {
  row: number;
  name: string;
  nameKey: string;
  tehsil?: string;
  district: { code: string; path: string };
  votes: Map<string, number>;
  /** First reason no zimmedar matched (reported only if no row of this village matched). */
  problem?: UnmatchedRow;
  /** Listed under a supervisor: goes to the district pool if no row names a zimmedar. */
  pool?: UnmatchedRow;
}

/**
 * Plan and (unless dryRun) apply. A village is matched in its district by its normalized name, by
 * an earlier spelling (formerNames) or through a merged duplicate; otherwise it is created. An
 * existing assignment is never replaced; merged villages are never revived.
 */
export async function importVillages(
  rows: VillageRow[],
  {
    dryRun,
    names = DistrictNames.load(),
    source,
    hr,
  }: { dryRun: boolean; names?: DistrictNames; source?: VillageImportSource; hr?: HrCodes },
): Promise<VillageImportResult> {
  await connectDb();
  const startedAt = new Date();

  const users = await User.find().select('_id ajeerCode name nameUr role unitCode unitPath').lean();
  const byCode = new Map(users.map((u) => [u.ajeerCode, u]));

  const units = await Unit.find().select('code name nameUr level parentCode path').lean();
  const unitByCode = new Map(units.map((u) => [u.code, u]));
  const districts = units.filter((u) => u.level === 'district');
  // Urdu chain "suba|division|district" → district, for the Roman spellings in district-names.csv.
  const urduKey = (...parts: string[]) => parts.map(unitKey).join('|');
  const districtByUrduChain = new Map<string, (typeof districts)[number]>();
  for (const d of districts) {
    const division = d.parentCode ? unitByCode.get(d.parentCode) : undefined;
    const suba = division?.parentCode ? unitByCode.get(division.parentCode) : undefined;
    if (division && suba) {
      districtByUrduChain.set(
        urduKey(suba.nameUr ?? suba.name, division.nameUr ?? division.name, d.nameUr ?? d.name),
        d,
      );
    }
  }
  const districtsByKey = new Map<string, typeof districts>();
  const districtByPath = new Map(districts.map((d) => [d.path, d]));
  for (const d of districts) {
    for (const n of new Set([d.name, d.nameUr].filter(Boolean) as string[])) {
      const k = unitKey(n);
      districtsByKey.set(k, [...(districtsByKey.get(k) ?? []), d]);
    }
  }

  const groups = new Map<string, Group>();
  const unmatchedVillages: UnmatchedRow[] = [];
  const noName: UnmatchedRow[] = [];
  const districtPool: UnmatchedRow[] = [];
  const unmatchedZimmedar: UnmatchedRow[] = [];
  const heldCode: UnmatchedRow[] = [];
  const notImportedEmployee: UnmatchedRow[] = [];
  const employeeOnHold: UnmatchedRow[] = [];
  const districtMismatch: UnmatchedRow[] = [];
  const labels = new Map<string, string>(); // user id → "<ajeer code> <name>"
  let duplicateRows = 0;

  for (const { row, values } of rows) {
    const name = clean(values.village);
    const tehsil = clean(values.tehsil);
    const districtText = clean(values.district);
    const codeText = clean(values.zimmedarCode);
    const code = normalizeAjeerCode(codeText);
    const codeFull = fullAjeerCode(codeText) ?? '';
    // "Usher Zimmedar Name": a reference for the reports only — never used to match (CTO 7 Nov).
    const refName = clean(values.zimmedarName);
    const report = (problem: string): UnmatchedRow => ({
      row,
      village: name,
      tehsil,
      district: districtText,
      zimmedar: codeText,
      zimmedarName: refName,
      problem,
    });

    if (!name) {
      noName.push(report('Gaon ka naam is missing'));
      continue;
    }

    // Codes of employees the HR import rejected or holds: their villages are never assigned. A /2 or
    // /3 code matches the zimmedar by the code before "/" (CTO 10 Nov 2026), so `held` only applies
    // to codes the HR side still lists as held (none since then).
    const held = !!code && (hr?.held.has(code) ?? false);
    const rejected = !!code && !held && (hr?.rejected.has(code) ?? false);
    const onHoldCode = !!code && !held && !rejected && (hr?.onHold?.has(code) ?? false);
    const user = code && !held && !rejected && !onHoldCode ? byCode.get(code) : undefined;

    // 1. District: always the file's District column (CTO 9 Nov 2026: an unknown or unmatched
    //    District name never falls back to the employee's HR district). For a zimmedar /
    //    district user the file's District must also be their own district, else an exception.
    let fileDistrict: { code: string; path: string } | undefined;
    if (districtText) {
      const chain = names.forVillageFileName(districtText);
      const mapped = chain
        ? districtByUrduChain.get(urduKey(chain.subaUr, chain.divisionUr, chain.districtUr))
        : undefined;
      const candidates = mapped ? [mapped] : (districtsByKey.get(unitKey(districtText)) ?? []);
      if (candidates.length === 1) {
        fileDistrict = { code: candidates[0]!.code, path: candidates[0]!.path };
      }
    }
    let userDistrict: { code: string; path: string } | undefined;
    if (user && (user.role === 'zimmedar' || user.role === 'tehsil' || user.role === 'district')) {
      // A zimmedar under a Tehsil belongs to that Tehsil's District (districtPathOf).
      const d = districtByPath.get(districtPathOf(user.unitPath) ?? user.unitPath);
      if (d) userDistrict = { code: d.code, path: d.path };
    }
    const outsideUser =
      user &&
      !userDistrict &&
      fileDistrict &&
      !(fileDistrict.path === user.unitPath || fileDistrict.path.startsWith(`${user.unitPath}/`));
    if ((userDistrict && fileDistrict && userDistrict.path !== fileDistrict.path) || outsideUser) {
      districtMismatch.push(
        report(
          `District "${districtText}" is not the district of Ajeer code ${code} (${user!.unitCode}) — not imported`,
        ),
      );
      continue;
    }
    // An employee on hold is not in the database, but their verified HR District still decides
    // "District farq" — the approved exception rows stay excluded (CTO 7 / 9 Nov 2026).
    const hrDistrict = onHoldCode ? hr?.districtOf?.get(code) : undefined;
    if (fileDistrict && hrDistrict) {
      const unit = districtByPath.get(fileDistrict.path);
      const same = [unit?.name, unit?.nameUr].some((n) => n && unitKey(n) === unitKey(hrDistrict));
      if (!same) {
        districtMismatch.push(
          report(
            `District "${districtText}" is not the HR district of Ajeer code ${code} (${hrDistrict}) — not imported`,
          ),
        );
        continue;
      }
    }
    const district = fileDistrict;
    if (!district) {
      unmatchedVillages.push(
        report(
          districtText
            ? `District "${districtText}" not recognised (no fallback to the employee's district)`
            : 'District is missing',
        ),
      );
      continue;
    }

    // 2. Zimmedar: only by the exact Ajeer Code, and only a user whose role is zimmedar.
    let assignee: { id: string; label: string } | undefined;
    let zimmedarProblem: string | undefined;
    let poolReason: string | undefined;
    if (held) {
      heldCode.push(report(`Ajeer code ${codeFull || code} is held (/2, /3) — CTO decides`));
    } else if (onHoldCode) {
      employeeOnHold.push(
        report(`Ajeer code ${code} is on hold in the HR import (no verified Tehsil parent)`),
      );
    } else if (rejected) {
      notImportedEmployee.push(
        report(`Ajeer code ${code} was not imported from the HR file (see its report)`),
      );
    } else if (code) {
      if (!user) zimmedarProblem = `Ajeer code ${code} not found (import employees first)`;
      else if (user.role !== 'zimmedar') {
        poolReason = `Ajeer code ${code} is a ${user.role} user → district pool`;
      } else if (districtPathOf(user.unitPath) !== district.path) {
        zimmedarProblem = `Ajeer code ${code} belongs to another district`;
      } else assignee = { id: String(user._id), label: `${user.ajeerCode} ${user.name}` };
    } else if (codeText) {
      zimmedarProblem = `Employee Code "${codeText}" is not an Ajeer Code`;
    } else if (refName) {
      zimmedarProblem = 'No Ajeer Code (zimmedar name kept for reference only)';
    } else {
      zimmedarProblem = 'No zimmedar given';
    }

    const nameKey = villageNameKey(name);
    const gk = `${district.path}|${nameKey}`;
    let group = groups.get(gk);
    if (group) duplicateRows += 1;
    else {
      group = { row, name, nameKey, ...(tehsil ? { tehsil } : {}), district, votes: new Map() };
      groups.set(gk, group);
    }
    if (assignee) {
      group.votes.set(assignee.id, (group.votes.get(assignee.id) ?? 0) + 1);
      labels.set(assignee.id, assignee.label);
    } else if (poolReason && !group.pool) {
      group.pool = report(poolReason);
    } else if (zimmedarProblem && !group.problem) {
      group.problem = report(zimmedarProblem);
    }
  }

  // 3. One zimmedar per village: the one most rows name; report villages named for several.
  const conflicts: Conflict[] = [];
  const plans = [...groups.values()].map((g) => {
    const ranked = [...g.votes.entries()].sort((a, b) => b[1] - a[1]);
    const chosen = ranked[0]?.[0];
    if (ranked.length > 1) {
      conflicts.push({
        village: g.name,
        district: g.district.code,
        zimmedaran: ranked.map(([id, n]) => `${labels.get(id)} (${n})`).join(', '),
        chosen: labels.get(chosen!) ?? '',
      });
    }
    if (!chosen && g.pool) districtPool.push(g.pool);
    else if (!chosen && g.problem) unmatchedZimmedar.push(g.problem);
    return { ...g, assignedTo: chosen };
  });

  // Existing villages of the districts in the file: live ones by name and earlier spellings, and
  // merged duplicates through the village they were merged into.
  const paths = [...new Set(plans.map((p) => p.district.path))];
  const existing = await Village.find({ unitPath: { $in: paths } })
    .select('_id name unitPath nameKey status mergedInto assignedTo formerNames')
    .lean();
  const liveById = new Map(
    existing.filter((v) => v.status !== 'merged').map((v) => [String(v._id), v]),
  );
  const byKey = new Map<string, (typeof existing)[number]>();
  for (const v of liveById.values()) byKey.set(`${v.unitPath}|${v.nameKey}`, v);
  for (const v of liveById.values()) {
    for (const f of v.formerNames ?? []) {
      const k = `${v.unitPath}|${f.nameKey}`;
      if (!byKey.has(k)) byKey.set(k, v);
    }
  }
  for (const v of existing) {
    if (v.status !== 'merged') continue;
    // Follow a chain of merges to the live village (bounded, in case of bad data).
    let target = v;
    for (let i = 0; i < 10 && target.status === 'merged' && target.mergedInto; i += 1) {
      const next = existing.find((x) => String(x._id) === String(target.mergedInto));
      if (!next) break;
      target = next;
    }
    const k = `${v.unitPath}|${v.nameKey}`;
    if (target.status !== 'merged' && !byKey.has(k)) byKey.set(k, target);
  }

  const userLabel = new Map(users.map((u) => [String(u._id), `${u.ajeerCode} ${u.name}`]));
  const assignmentKept: VillageImportResult['assignmentKept'] = [];
  const formerNameMatches: VillageImportResult['formerNameMatches'] = [];
  const matched = plans.map((p) => {
    const match = byKey.get(`${p.district.path}|${p.nameKey}`);
    if (match && match.nameKey !== p.nameKey) {
      formerNameMatches.push({ inFile: p.name, district: p.district.code, village: match.name });
    }
    if (match?.assignedTo && p.assignedTo && String(match.assignedTo) !== p.assignedTo) {
      assignmentKept.push({
        village: match.name,
        district: p.district.code,
        current: userLabel.get(String(match.assignedTo)) ?? String(match.assignedTo),
        inFile: labels.get(p.assignedTo) ?? p.assignedTo,
      });
    }
    return { plan: p, match };
  });

  const result: VillageImportResult = {
    dryRun,
    rows: rows.length,
    villages: plans.length,
    duplicateRows,
    created: matched.filter((m) => !m.match).length,
    updated: matched.filter((m) => m.match).length,
    assigned: plans.filter((p) => p.assignedTo).length,
    unmatchedVillages,
    noName,
    districtPool,
    unmatchedZimmedar,
    conflicts,
    assignmentKept,
    formerNameMatches,
    heldCode,
    notImportedEmployee,
    employeeOnHold,
    districtMismatch,
  };
  if (dryRun || plans.length === 0) return result;

  // Two names of the file can lead to one village (a name and its earlier spelling): update once.
  const seen = new Set<string>();
  const ops: AnyBulkWriteOperation<VillageDoc>[] = [];
  for (const { plan: p, match } of matched) {
    if (match) {
      const id = String(match._id);
      if (seen.has(id)) continue;
      seen.add(id);
      ops.push(
        {
          updateOne: {
            filter: { _id: match._id, status: { $in: LIVE_STATUS } },
            update: {
              $set: {
                status: 'approved' as const,
                ...(p.tehsil ? { tehsil: p.tehsil } : {}),
                ...(match.status === 'pending' ? { approvedAt: startedAt } : {}),
              },
            },
          },
        },
        // Only a village nobody is responsible for gets the file's zimmedar.
        ...(p.assignedTo
          ? [
              {
                updateOne: {
                  filter: { _id: match._id, assignedTo: null },
                  update: { $set: { assignedTo: new Types.ObjectId(p.assignedTo) } },
                },
              },
            ]
          : []),
      );
      continue;
    }
    ops.push({
      insertOne: {
        document: {
          createdAt: startedAt,
          updatedAt: startedAt,
          name: p.name,
          nameKey: p.nameKey,
          districtCode: p.district.code,
          unitPath: p.district.path,
          ...(p.tehsil ? { tehsil: p.tehsil } : {}),
          status: 'approved' as const,
          approvedAt: startedAt,
          ...(p.assignedTo ? { assignedTo: new Types.ObjectId(p.assignedTo) } : {}),
          source: {
            kind: 'import' as const,
            ...(source ? { file: source.file } : {}),
            row: p.row,
            at: startedAt,
          },
        },
      },
    });
  }
  if (ops.length > 0) await Village.bulkWrite(ops, { ordered: false });

  // One audit entry per real run: counts only.
  await audit({
    action: 'IMPORT_VILLAGES',
    actorAjeerCode: source?.operator ?? 'import',
    targetType: 'import',
    details: {
      ...(source ? { file: source.file } : {}),
      rows: result.rows,
      villages: result.villages,
      created: result.created,
      updated: result.updated,
      assigned: result.assigned,
      notImported: result.unmatchedVillages.length + result.noName.length,
      assignmentKept: result.assignmentKept.length,
    },
  });
  return result;
}

const LIVE_STATUS: ('approved' | 'pending')[] = ['approved', 'pending'];

/** Excel report with one sheet per problem list (Urdu text is kept as is; stays in private/). */
export async function writeVillageReport(result: VillageImportResult, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, columns: string[], rows: (string | number)[][]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(columns).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    ws.columns.forEach((c) => (c.width = 24));
  };
  const ROW_COLUMNS = [
    'Row',
    'Gaon',
    'Tehsil',
    'District',
    'Employee Code',
    'Naam (reference)',
    'Masla',
  ];
  const rowSheet = (name: string, list: UnmatchedRow[]) =>
    sheet(
      name,
      ROW_COLUMNS,
      list.map((u) => [
        u.row,
        u.village,
        u.tehsil,
        u.district,
        u.zimmedar,
        u.zimmedarName,
        u.problem,
      ]),
    );
  rowSheet('Gaon nahi mile', result.unmatchedVillages);
  rowSheet('Bina naam', result.noName);
  rowSheet('District farq', result.districtMismatch);
  rowSheet('Code 2, 3 - rukay hue', result.heldCode);
  rowSheet('Employee import nahi hua', result.notImportedEmployee);
  rowSheet('Employee hold', result.employeeOnHold);
  rowSheet('District pool', result.districtPool);
  rowSheet('Zimmedar nahi mila', result.unmatchedZimmedar);
  sheet(
    'Aik gaon, kai zimmedar',
    ['Gaon', 'District', 'Zimmedaran (rows)', 'Chuna gaya'],
    result.conflicts.map((c) => [c.village, c.district, c.zimmedaran, c.chosen]),
  );
  sheet(
    'Assignment barqarar',
    ['Gaon', 'District', 'Abhi kis ke paas (rakha gaya)', 'File mein'],
    result.assignmentKept.map((a) => [a.village, a.district, a.current, a.inFile]),
  );
  sheet(
    'Purane naam se mila',
    ['File mein naam', 'District', 'System mein gaon'],
    result.formerNameMatches.map((m) => [m.inFile, m.district, m.village]),
  );
  await wb.xlsx.writeFile(file);
}
