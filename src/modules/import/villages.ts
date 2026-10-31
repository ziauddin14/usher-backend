// Village list import (Excel) — run AFTER the employee import. Real data stays in backend/private/.
// Each village gets status "approved" and is assigned to its Ushar Zimmedar (assignedTo).
import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import { normalizeAjeerCode } from '../../lib/ajeer-code.js';
import { connectDb } from '../../lib/db.js';
import { villageNameKey } from '../../lib/text.js';
import { unitKey } from '../../lib/unit-name.js';
import { headerKey, loadWorkbook, readRows } from '../../lib/xlsx.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';

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
    'اجیر کوڈ',
    'عملہ کوڈ',
  ],
  zimmedarName: [
    'Zimmedar',
    'Zimmedar Naam',
    'Zimmedar Name',
    'User Name',
    'Ushar Zimmedar',
    'عشر ذمہ دار',
  ],
} as const;
type Column = keyof typeof COLUMNS;
const COLUMN_KEYS = Object.fromEntries(
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
  /** Villages imported without a zimmedar, because the zimmedar could not be matched. */
  unmatchedZimmedar: UnmatchedRow[];
  conflicts: Conflict[];
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
}

/** Plan and (unless dryRun) apply. Upsert by district + nameKey; never touches merged villages. */
export async function importVillages(
  rows: VillageRow[],
  { dryRun }: { dryRun: boolean },
): Promise<VillageImportResult> {
  await connectDb();

  const users = await User.find().select('_id ajeerCode name nameUr role unitCode unitPath').lean();
  const byCode = new Map(users.map((u) => [u.ajeerCode, u]));
  const nameKeyOf = (s: string) => headerKey(s);

  const districts = await Unit.find({ level: 'district' }).select('code name nameUr path').lean();
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
  const unmatchedZimmedar: UnmatchedRow[] = [];
  const labels = new Map<string, string>(); // user id → "<ajeer code> <name>"
  let duplicateRows = 0;

  for (const { row, values } of rows) {
    const name = clean(values.village);
    const tehsil = clean(values.tehsil);
    const districtText = clean(values.district);
    const codeText = clean(values.zimmedarCode);
    const code = normalizeAjeerCode(codeText);
    const zimmedarText = code ? '' : codeText || clean(values.zimmedarName);
    const report = (problem: string): UnmatchedRow => ({
      row,
      village: name,
      tehsil,
      district: districtText,
      zimmedar: code ?? zimmedarText,
      problem,
    });

    if (!name) {
      unmatchedVillages.push(report('Gaon ka naam is missing'));
      continue;
    }

    // 1. District: from the zimmedar's own district, else by name (inside the user's area).
    const user = code ? byCode.get(code) : undefined;
    let district: { code: string; path: string } | undefined;
    if (user && (user.role === 'zimmedar' || user.role === 'district')) {
      const d = districtByPath.get(user.unitPath);
      if (d) district = { code: d.code, path: d.path };
    }
    if (!district && districtText) {
      const candidates = (districtsByKey.get(unitKey(districtText)) ?? []).filter(
        (d) => !user || d.path === user.unitPath || d.path.startsWith(`${user.unitPath}/`),
      );
      if (candidates.length === 1)
        district = { code: candidates[0]!.code, path: candidates[0]!.path };
    }
    if (!district) {
      unmatchedVillages.push(
        report(districtText ? `District "${districtText}" not found` : 'District is missing'),
      );
      continue;
    }

    // 2. Zimmedar: by ajeer code, else by name among the district's zimmedaran.
    let assignee: { id: string; label: string } | undefined;
    let zimmedarProblem: string | undefined;
    if (code) {
      if (!user) zimmedarProblem = `Ajeer code ${code} not found (import employees first)`;
      else if (user.role !== 'zimmedar') {
        zimmedarProblem = `Ajeer code ${code} is a ${user.role} user, not an Ushar Zimmedar`;
      } else if (user.unitPath !== district.path) {
        zimmedarProblem = `Ajeer code ${code} belongs to another district`;
      } else assignee = { id: String(user._id), label: `${user.ajeerCode} ${user.name}` };
    } else if (zimmedarText) {
      const key = nameKeyOf(zimmedarText);
      const found = users.filter(
        (u) =>
          u.role === 'zimmedar' &&
          u.unitPath === district.path &&
          (nameKeyOf(u.name) === key || (u.nameUr ? nameKeyOf(u.nameUr) === key : false)),
      );
      if (found.length === 1) {
        assignee = { id: String(found[0]!._id), label: `${found[0]!.ajeerCode} ${found[0]!.name}` };
      } else {
        zimmedarProblem =
          found.length > 1
            ? `More than one zimmedar named "${zimmedarText}" in the district`
            : `Zimmedar "${zimmedarText}" not found in the district`;
      }
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
    if (!chosen && g.problem) unmatchedZimmedar.push(g.problem);
    return { ...g, assignedTo: chosen };
  });

  const existing = await Village.find({
    status: { $in: ['approved', 'pending'] as ('approved' | 'pending')[] },
  })
    .select('_id unitPath nameKey')
    .lean();
  const existingKeys = new Set(existing.map((v) => `${v.unitPath}|${v.nameKey}`));

  const result: VillageImportResult = {
    dryRun,
    rows: rows.length,
    villages: plans.length,
    duplicateRows,
    created: plans.filter((p) => !existingKeys.has(`${p.district.path}|${p.nameKey}`)).length,
    updated: plans.filter((p) => existingKeys.has(`${p.district.path}|${p.nameKey}`)).length,
    assigned: plans.filter((p) => p.assignedTo).length,
    unmatchedVillages,
    unmatchedZimmedar,
    conflicts,
  };
  if (dryRun || plans.length === 0) return result;

  await Village.bulkWrite(
    plans.map((p) => ({
      updateOne: {
        filter: {
          unitPath: p.district.path,
          nameKey: p.nameKey,
          status: { $in: ['approved', 'pending'] as ('approved' | 'pending')[] },
        },
        update: {
          $set: {
            status: 'approved' as const,
            ...(p.tehsil ? { tehsil: p.tehsil } : {}),
            ...(p.assignedTo ? { assignedTo: new Types.ObjectId(p.assignedTo) } : {}),
          },
          $setOnInsert: { name: p.name, districtCode: p.district.code },
        },
        upsert: true,
      },
    })),
  );
  return result;
}

/** Excel report with one sheet per problem list (Urdu text is kept as is). */
export async function writeVillageReport(result: VillageImportResult, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, columns: string[], rows: (string | number)[][]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(columns).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    ws.columns.forEach((c) => (c.width = 24));
  };
  sheet(
    'Gaon nahi mile',
    ['Row', 'Gaon', 'Tehsil', 'District', 'Zimmedar', 'Masla'],
    result.unmatchedVillages.map((u) => [
      u.row,
      u.village,
      u.tehsil,
      u.district,
      u.zimmedar,
      u.problem,
    ]),
  );
  sheet(
    'Zimmedar nahi mila',
    ['Row', 'Gaon', 'Tehsil', 'District', 'Zimmedar', 'Masla'],
    result.unmatchedZimmedar.map((u) => [
      u.row,
      u.village,
      u.tehsil,
      u.district,
      u.zimmedar,
      u.problem,
    ]),
  );
  sheet(
    'Aik gaon, kai zimmedar',
    ['Gaon', 'District', 'Zimmedaran (rows)', 'Chuna gaya'],
    result.conflicts.map((c) => [c.village, c.district, c.zimmedaran, c.chosen]),
  );
  await wb.xlsx.writeFile(file);
}
