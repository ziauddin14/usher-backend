// Shoba Ushar's donor list (CSV / Excel, CTO 12 Nov 2026) → donors of each Gaon. Run AFTER the
// employee and Gaon imports. Real data stays in backend/private/ (git-ignored).
//
// Columns: Mulk, Soba, Division, District, Tehsil, ID (Ajeer Code), User Name, گاؤں کا نام,
// گاؤں ذمہ دار کا نام, گاؤں ذمہ دار کا نمبر, نام ڈونر, ڈونر موبائل نمبر, زیر کاشت رقبہ(ایکڑ).
//
// Decisions (CTO 12 Nov 2026):
//  - A donor belongs to its Gaon; whoever has the Gaon assigned sees its donors. The file's ID only
//    helps find the District when the District column does not map.
//  - A Gaon not found in the Gaon list (spelling, or missing) → report; those donors are imported
//    later by running the same file again (nothing is ever doubled).
//  - The Gaon's local zimmedar (name, number) is saved on the Gaon.
// One donor per mobile per Gaon (without a mobile: per name). A row repeated in the file is merged.
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { type AnyBulkWriteOperation, Types } from 'mongoose';
import { normalizeAjeerCode } from '../../lib/ajeer-code.js';
import { audit } from '../../lib/audit.js';
import { connectDb } from '../../lib/db.js';
import { DistrictNames } from '../../lib/district-names.js';
import { normalizeMobile } from '../../lib/mobile.js';
import { districtPathOf } from '../../lib/scope.js';
import { looseVillageKey, villageNameKey } from '../../lib/text.js';
import { karachiDate } from '../../lib/time.js';
import { unitKey } from '../../lib/unit-name.js';
import { headerKey, loadWorkbook } from '../../lib/xlsx.js';
import { Donor, type DonorDoc } from '../../models/donor.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { parseCsv } from '../erp/parse.js';

const COLUMNS = {
  district: ['District', 'ضلع', 'ڈسٹرکٹ'],
  tehsil: ['Tehsil', 'تحصیل'],
  code: ['ID', 'Ajeer Code', 'اجیر کوڈ'],
  village: ['گاؤں کا نام', 'Gaon', 'Gaon ka naam', 'Village'],
  localName: ['گاؤں ذمہ دار کا نام'],
  localMobile: ['گاؤں ذمہ دار کا نمبر'],
  donorName: ['نام ڈونر', 'Donor Name', 'ڈونر کا نام'],
  donorMobile: ['ڈونر موبائل نمبر', 'Donor Mobile'],
  acres: ['زیر کاشت رقبہ(ایکڑ)', 'زیر کاشت رقبہ', 'Acres'],
} as const;
type Column = keyof typeof COLUMNS;

export interface DonorRow {
  row: number;
  values: Partial<Record<Column, string>>;
}

/** The file → rows of known columns (first row with the Gaon and donor-name columns = header). */
export async function readDonorFile(file: string): Promise<DonorRow[]> {
  const table = /\.xlsx$/i.test(file)
    ? await xlsxTable(file)
    : parseCsv((await readFile(file)).toString('utf8'));
  const keys = Object.fromEntries(
    Object.entries(COLUMNS).map(([c, names]) => [c, (names as readonly string[]).map(headerKey)]),
  ) as Record<Column, string[]>;
  for (let at = 0; at < Math.min(table.length, 20); at += 1) {
    const header = new Map<number, Column>();
    table[at]!.forEach((text, col) => {
      const k = headerKey(text);
      const c = (Object.keys(keys) as Column[]).find((x) => keys[x].includes(k));
      if (c && ![...header.values()].includes(c)) header.set(col, c);
    });
    const found = [...header.values()];
    if (!found.includes('village') || !found.includes('donorName')) continue;
    return table
      .slice(at + 1)
      .map((cells, i) => {
        const values: Partial<Record<Column, string>> = {};
        for (const [col, c] of header) {
          const text = cells[col]?.replace(/\s+/g, ' ').trim();
          if (text) values[c] = text;
        }
        return { row: at + 2 + i, values };
      })
      .filter((r) => Object.keys(r.values).length > 0);
  }
  throw new Error('No header row with "گاؤں کا نام" and "نام ڈونر"');
}

async function xlsxTable(file: string): Promise<string[][]> {
  const wb = await loadWorkbook(file);
  const ws = wb.worksheets[0];
  const rows: string[][] = [];
  ws?.eachRow({ includeEmpty: true }, (r, n) => {
    const cells: string[] = [];
    r.eachCell({ includeEmpty: true }, (c, col) => (cells[col - 1] = c.text));
    rows[n - 1] = Array.from(cells, (c) => c ?? '');
  });
  return Array.from(rows, (r) => r ?? []);
}

export interface DonorReportRow {
  row: number;
  district: string;
  tehsil: string;
  code: string;
  village: string;
  donor: string;
  problem: string;
}

export interface DonorImportResult {
  rows: number;
  donorsInFile: number;
  repeatedRows: number;
  created: number;
  updated: number;
  unchanged: number;
  withMobile: number;
  /** Rows whose Gaon was found through the ID's District (the District column did not map). */
  districtFromId: number;
  localZimmedarSet: number;
  villageNotFound: DonorReportRow[];
  districtNotFound: DonorReportRow[];
  noDonorName: DonorReportRow[];
  badMobile: DonorReportRow[];
}

const clean = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim() ?? '';

/** Donor list → donors (upsert) and Gaon local zimmedar. `dryRun` reads only. */
export async function importDonors(
  rows: DonorRow[],
  {
    dryRun,
    names = DistrictNames.load(),
    source,
  }: { dryRun: boolean; names?: DistrictNames; source?: { file: string; operator: string } },
): Promise<DonorImportResult> {
  await connectDb();
  const now = new Date();
  const today = karachiDate(now);

  const units = await Unit.find({ level: { $in: ['suba', 'division', 'district'] } })
    .select('code name nameUr level parentCode path')
    .lean();
  const byCode = new Map(units.map((u) => [u.code, u]));
  const districts = units.filter((u) => u.level === 'district');
  const chainKey = (...parts: string[]) => parts.map(unitKey).join('|');
  const byChain = new Map<string, (typeof districts)[number]>();
  const byKey = new Map<string, typeof districts>();
  for (const d of districts) {
    const division = d.parentCode ? byCode.get(d.parentCode) : undefined;
    const suba = division?.parentCode ? byCode.get(division.parentCode) : undefined;
    if (division && suba) {
      byChain.set(
        chainKey(suba.nameUr ?? suba.name, division.nameUr ?? division.name, d.nameUr ?? d.name),
        d,
      );
    }
    for (const n of new Set([d.name, d.nameUr].filter(Boolean) as string[])) {
      byKey.set(unitKey(n), [...(byKey.get(unitKey(n)) ?? []), d]);
    }
  }
  const districtOfText = (text: string): string | undefined => {
    const chain = names.forVillageFileName(text);
    const mapped = chain
      ? byChain.get(chainKey(chain.subaUr, chain.divisionUr, chain.districtUr))
      : undefined;
    const list = mapped ? [mapped] : (byKey.get(unitKey(text)) ?? []);
    return list.length === 1 ? list[0]!.path : undefined;
  };
  const users = await User.find().select('ajeerCode unitPath').lean();
  const userPath = new Map(users.map((u) => [u.ajeerCode, u.unitPath]));

  // Live Gaon of the Districts in the file, by name key, former name key and loose key.
  const villages = await Village.find({ status: { $in: ['approved', 'pending'] } })
    .select('_id unitPath nameKey formerNames localZimmedar')
    .lean();
  const exact = new Map<string, (typeof villages)[number][]>();
  const loose = new Map<string, (typeof villages)[number][]>();
  const add = (m: typeof exact, k: string, v: (typeof villages)[number]) =>
    m.set(k, [...(m.get(k) ?? []), v]);
  for (const v of villages) {
    add(exact, `${v.unitPath}|${v.nameKey}`, v);
    for (const f of v.formerNames ?? []) add(exact, `${v.unitPath}|${f.nameKey}`, v);
    add(loose, `${v.unitPath}|${looseVillageKey(v.nameKey)}`, v);
  }
  const findVillage = (district: string, name: string) => {
    const e = [...new Set(exact.get(`${district}|${villageNameKey(name)}`) ?? [])];
    if (e.length === 1) return e[0];
    const l = loose.get(`${district}|${looseVillageKey(name)}`) ?? [];
    return l.length === 1 ? l[0] : undefined;
  };

  const result: DonorImportResult = {
    rows: rows.length,
    donorsInFile: 0,
    repeatedRows: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    withMobile: 0,
    districtFromId: 0,
    localZimmedarSet: 0,
    villageNotFound: [],
    districtNotFound: [],
    noDonorName: [],
    badMobile: [],
  };

  interface Planned {
    row: number;
    villageId: Types.ObjectId;
    unitPath: string;
    name: string;
    nameKey: string;
    mobile?: string;
    acres?: number;
  }
  const planned = new Map<string, Planned>();
  const local = new Map<string, { name?: string; mobile?: string }>();

  for (const { row, values } of rows) {
    const village = clean(values.village);
    const donorName = clean(values.donorName);
    const report = (problem: string): DonorReportRow => ({
      row,
      district: clean(values.district),
      tehsil: clean(values.tehsil),
      code: clean(values.code),
      village,
      donor: donorName,
      problem,
    });
    let district = values.district ? districtOfText(clean(values.district)) : undefined;
    if (!district) {
      const code = normalizeAjeerCode(values.code);
      const path = code ? userPath.get(code) : undefined;
      district = path ? (districtPathOf(path) ?? undefined) : undefined;
      if (district) result.districtFromId += 1;
    }
    if (!district) {
      result.districtNotFound.push(report('District nahi mila (na District column, na ID)'));
      continue;
    }
    const v = village ? findVillage(district, village) : undefined;
    if (!v) {
      result.villageNotFound.push(
        report(village ? 'Gaon list mein nahi mila' : 'Gaon ka naam khali'),
      );
      continue;
    }
    // The Gaon's local zimmedar: the first row that gives one.
    const id = String(v._id);
    const ln = clean(values.localName);
    const lm = values.localMobile ? normalizeMobile(values.localMobile) : null;
    if ((ln || lm) && !local.has(id)) {
      local.set(id, { ...(ln ? { name: ln.slice(0, 80) } : {}), ...(lm ? { mobile: lm } : {}) });
    }
    if (!donorName) {
      result.noDonorName.push(report('Donor ka naam khali'));
      continue;
    }
    const mobile = values.donorMobile ? normalizeMobile(values.donorMobile) : null;
    if (values.donorMobile && !mobile)
      result.badMobile.push(report('Mobile number sahi nahi — baghair number import'));
    const acresNum = values.acres ? Number(values.acres.replace(/,/g, '')) : NaN;
    const nameKey = villageNameKey(donorName);
    const key = `${id}|${mobile ?? `name:${nameKey}`}`;
    if (planned.has(key)) {
      result.repeatedRows += 1;
      continue;
    }
    planned.set(key, {
      row,
      villageId: v._id,
      unitPath: v.unitPath,
      name: donorName.slice(0, 80),
      nameKey,
      ...(mobile ? { mobile } : {}),
      ...(Number.isFinite(acresNum) && acresNum >= 0 ? { acres: acresNum } : {}),
    });
  }
  result.donorsInFile = planned.size;
  result.withMobile = [...planned.values()].filter((p) => p.mobile).length;

  // Existing donors of these Gaon → created / updated / unchanged.
  const villageIds = [...new Set([...planned.values()].map((p) => String(p.villageId)))].map(
    (id) => new Types.ObjectId(id),
  );
  const existing = await Donor.find({ villageId: { $in: villageIds } })
    .select('villageId mobile nameKey name acres')
    .lean();
  const existingBy = new Map<string, (typeof existing)[number]>();
  for (const e of existing) {
    existingBy.set(`${String(e.villageId)}|${e.mobile ?? `name:${e.nameKey}`}`, e);
  }
  const writes: AnyBulkWriteOperation<DonorDoc>[] = [];
  for (const [key, p] of planned) {
    const old = existingBy.get(key);
    if (old && old.name === p.name && (old.acres ?? null) === (p.acres ?? null)) {
      result.unchanged += 1;
      continue;
    }
    if (old) result.updated += 1;
    else result.created += 1;
    writes.push({
      updateOne: {
        filter: p.mobile
          ? { villageId: p.villageId, mobile: p.mobile }
          : { villageId: p.villageId, nameKey: p.nameKey, mobile: { $exists: false } },
        update: {
          $set: {
            name: p.name,
            nameKey: p.nameKey,
            ...(p.acres !== undefined ? { acres: p.acres } : {}),
          },
          $setOnInsert: {
            villageId: p.villageId,
            unitPath: p.unitPath,
            ...(p.mobile ? { mobile: p.mobile } : {}),
            addedOn: today,
            source: {
              kind: 'import',
              ...(source ? { file: source.file } : {}),
              row: p.row,
              at: now,
            },
            meetings: 0,
            isActive: true,
          },
        },
        upsert: true,
      },
    });
  }
  const localWrites = [...local].map(([id, lz]) => ({
    updateOne: { filter: { _id: new Types.ObjectId(id) }, update: { $set: { localZimmedar: lz } } },
  }));
  result.localZimmedarSet = localWrites.length;

  if (!dryRun) {
    for (let i = 0; i < writes.length; i += 1000) {
      await Donor.bulkWrite(writes.slice(i, i + 1000), { ordered: false });
    }
    if (localWrites.length) await Village.bulkWrite(localWrites, { ordered: false });
    await audit({
      action: 'IMPORT_DONORS',
      actorAjeerCode: source?.operator ?? 'import',
      targetType: 'import',
      details: {
        ...(source ? { file: source.file } : {}),
        rows: result.rows,
        donorsInFile: result.donorsInFile,
        created: result.created,
        updated: result.updated,
        notImported:
          result.villageNotFound.length +
          result.districtNotFound.length +
          result.noDonorName.length,
      },
    });
  }
  return result;
}

/** Exceptions → Excel for the Districts (stays in private/, git-ignored). */
export async function writeDonorReport(result: DonorImportResult, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, list: DonorReportRow[]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(['Row', 'District', 'Tehsil', 'ID', 'Gaon', 'Donor', 'Masla']).font = { bold: true };
    for (const r of list)
      ws.addRow([r.row, r.district, r.tehsil, r.code, r.village, r.donor, r.problem]);
    ws.columns.forEach((c) => (c.width = 24));
  };
  sheet('Gaon nahi mila', result.villageNotFound);
  sheet('District nahi mila', result.districtNotFound);
  sheet('Donor naam khali', result.noDonorName);
  sheet('Mobile ghalat', result.badMobile);
  await wb.xlsx.writeFile(file);
}
