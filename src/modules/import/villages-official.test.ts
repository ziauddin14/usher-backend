// The official Gaon list layout (CTO 7 Nov 2026), with invented rows in a throw-away file:
// "Employee Code" = the Ajeer Code (exact match), "Usher Zimmedar Name" = reference only, only a
// zimmedar receives an assignment (a /2 or /3 code: the zimmedar of the code before "/", CTO 10
// Nov 2026), supervisors' villages go to the district pool, rejected and on-hold employees'
// villages and district mismatches are exceptions, one village per district + name. The village
// contact columns are never read.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';
import { hrCodesFromPlan, type RawRow, validateRows } from './employees.js';
import {
  type HrCodes,
  importVillages,
  readVillageSheet,
  type VillageImportResult,
  writeVillageReport,
} from './villages.js';

const HEADER = [
  'Mulk',
  'Soba',
  'Division',
  'District',
  'Tehsil',
  'گاؤں کا نام',
  'Employee Code',
  'Usher Zimmedar Name',
  'گاؤں ذمہ دار کا نام',
  'گاؤں ذمہ دار کا نمبر',
];
const CONTACT_NAME = 'فرضی مقامی شخص';
const CONTACT_PHONE = '03119876543';

let dir: string;
let file: string;
let arifId: string;
let other: { id: string; code: string };
let dry: VillageImportResult;
let hr: HrCodes;

const row = (district: string, gaon: string, code: string, refName = 'Reference Name') => [
  'Pakistan',
  'Interior Sindh',
  'Sukkur',
  district,
  'Ubauro',
  gaon,
  code,
  refName,
  CONTACT_NAME,
  CONTACT_PHONE,
];

describe('official Gaon list: exact Ajeer Code, zimmedar-only assignment, exceptions', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ushr-gaon-'));
    await seedDemo({ reset: true });
    arifId = String((await User.findOne({ ajeerCode: '9090412' }).lean())!._id);
    const o = await User.findOne({
      role: 'zimmedar',
      unitCode: 'GHOTKI',
      ajeerCode: { $ne: '9090412' },
    }).lean();
    other = { id: String(o!._id), code: o!.ajeerCode };

    // The HR side: 880055 is rejected (designation not confirmed), 880066/3 is an Ushar without a
    // Tehsil parent (on hold, login 880066).
    const hrRows: RawRow[] = [
      {
        row: 5,
        values: {
          ajeerCode: '880055',
          name: 'C',
          zimmedari: 'آفس ذمہ دار',
          suba: 'S',
          division: 'D',
          district: 'X',
        },
      },
      {
        row: 6,
        values: {
          ajeerCode: '880066/3',
          name: 'D',
          zimmedari: 'Ushar',
          suba: 'S',
          division: 'D',
          district: 'Ghotki',
        },
      },
    ];
    hr = hrCodesFromPlan(validateRows(hrRows));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Official Gaon list (test)']);
    ws.addRow(HEADER);
    for (const r of [
      row('District Ghotki', 'گوٹھ سرکاری الف', '9090412'), // 3: exact code → arif
      row('District Ghotki', 'گوٹھ   سرکاری الف', '9090412'), // 4: same village again (contact)
      row('Ghotki District', 'سرکاری الف', '9090412'), // 5: same district + name → one village
      row('District Ghotki', 'گوٹھ ضلعی سرکاری', '9040001'), // 6: a district user → pool
      row('District Ghotki', 'گوٹھ ڈویژنی سرکاری', '9030001'), // 7: a division user → pool
      row('District Ghotki', 'گوٹھ رکا ہوا', `${other.code}/2`), // 8: /2 → the code before "/"
      row('District Ghotki', 'گوٹھ رکا ہوا دو', '880066/3'), // 9: a /3 code of an employee on hold
      row('District Ghotki', 'گوٹھ مسترد', '880055'), // 10: employee rejected by HR
      row('District Ghotki', 'گوٹھ نامعلوم', '77777'), // 11: code not in the employees
      row('District Ghotki', 'گوٹھ صرف نام', '', 'Muhammad Arif'), // 12: name only → never matched
      row('Larkana District', 'گوٹھ غلط ضلع', '9090412'), // 13: arif is not in Larkana
      row('District Ghotki', '', '9090412'), // 14: no name
      row('Atlantis District', 'گوٹھ کہیں نہیں', ''), // 15: district unknown
    ]) {
      ws.addRow(r);
    }
    file = join(dir, 'Gaonlist.xlsx');
    await wb.xlsx.writeFile(file);
    dry = await importVillages(await readVillageSheet(file), { dryRun: true, hr });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads Employee Code as the Ajeer Code and the zimmedar name as a reference; never the contact columns', async () => {
    const rows = await readVillageSheet(file);
    expect(rows[0]!.values).toMatchObject({
      zimmedarCode: '9090412',
      zimmedarName: 'Reference Name',
      district: 'District Ghotki',
    });
    expect(JSON.stringify(rows)).not.toContain(CONTACT_PHONE);
    expect(JSON.stringify(rows)).not.toContain(CONTACT_NAME);
    expect(JSON.stringify(dry)).not.toContain(CONTACT_PHONE);
  });

  it('dry run: one village per district + name; only the zimmedar is assigned; every exception listed', async () => {
    expect(dry).toMatchObject({ dryRun: true, rows: 13, duplicateRows: 2, assigned: 2 });
    expect(dry.districtPool.map((u) => u.row)).toEqual([6, 7]);
    expect(dry.heldCode).toEqual([]); // no /2, /3 hold since CTO 10 Nov 2026
    expect(dry.employeeOnHold.map((u) => u.row)).toEqual([9]);
    expect(dry.notImportedEmployee.map((u) => u.row)).toEqual([10]);
    expect(dry.unmatchedZimmedar.map((u) => [u.row, u.problem])).toEqual([
      [11, 'Ajeer code 77777 not found (import employees first)'],
      [12, 'No Ajeer Code (zimmedar name kept for reference only)'],
    ]);
    expect(dry.districtMismatch.map((u) => u.row)).toEqual([13]);
    expect(dry.noName.map((u) => u.row)).toEqual([14]);
    expect(dry.unmatchedVillages.map((u) => u.row)).toEqual([15]);
    // The reference name travels with the exception rows (report only).
    expect(dry.unmatchedZimmedar[1]!.zimmedarName).toBe('Muhammad Arif');
    expect(await Village.exists({ nameKey: 'سرکاری الف' })).toBeNull(); // nothing written
  });

  it('a real run assigns only the exact zimmedar; supervisors, on-hold and rejected codes get nobody', async () => {
    await importVillages(await readVillageSheet(file), { dryRun: false, hr });
    const alif = await Village.find({ nameKey: 'سرکاری الف' }).lean();
    expect(alif).toHaveLength(1);
    expect(String(alif[0]!.assignedTo)).toBe(arifId);
    // "<code>/2" in the Gaon file → the zimmedar who logs in with <code>.
    expect(String((await Village.findOne({ nameKey: 'رکا ہوا' }).lean())!.assignedTo)).toBe(
      other.id,
    );
    for (const nameKey of [
      'ضلعی سرکاری',
      'ڈویژنی سرکاری',
      'رکا ہوا دو',
      'مسترد',
      'نامعلوم',
      'صرف نام',
    ]) {
      const v = await Village.findOne({ nameKey }).lean();
      expect(v, nameKey).toMatchObject({ status: 'approved', districtCode: 'GHOTKI' });
      expect(v!.assignedTo, nameKey).toBeUndefined();
    }
    // A district mismatch, a missing name and an unknown district are not imported at all.
    expect(await Village.exists({ nameKey: 'غلط ضلع' })).toBeNull();
    expect(await Village.exists({ nameKey: 'کہیں نہیں' })).toBeNull();
    // Nothing of the village contact columns is stored.
    expect(JSON.stringify(await Village.find().lean())).not.toContain(CONTACT_PHONE);
  });

  it('the report keeps every exception on its own sheet, with the reference name', async () => {
    const out = join(dir, 'report.xlsx');
    await writeVillageReport(dry, out);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const rowsOf = (name: string) => wb.getWorksheet(name)!.rowCount - 1;
    expect(rowsOf('District farq')).toBe(1);
    expect(rowsOf('Code 2, 3 - rukay hue')).toBe(0);
    expect(rowsOf('Employee hold')).toBe(1);
    expect(rowsOf('Employee import nahi hua')).toBe(1);
    expect(rowsOf('District pool')).toBe(2);
    expect(rowsOf('Zimmedar nahi mila')).toBe(2);
    const header = wb.getWorksheet('Zimmedar nahi mila')!.getRow(1).values as string[];
    expect(header).toContain('Naam (reference)');
  });

  it('an employee on hold (Tehsil pending / no Tehsil parent) gets no village; rows are listed', async () => {
    // The HR District of the held employee still decides "District farq" (approved exceptions
    // stay excluded): rows 3–5 are in Ghotki → on hold; row 13 says Larkana → District farq.
    const onHold: HrCodes = {
      ...hr,
      onHold: new Set(['9090412']),
      districtOf: new Map([['9090412', 'Ghotki']]),
    };
    const r = await importVillages(await readVillageSheet(file), { dryRun: true, hr: onHold });
    expect(r.employeeOnHold.map((u) => u.row)).toEqual([3, 4, 5]);
    expect(r.districtMismatch.map((u) => u.row)).toEqual([13]);
    expect(r.districtMismatch[0]!.problem).toMatch(/HR district/);
    expect(r.assigned).toBe(1); // only row 8 (the other zimmedar's /2 code)
    expect(r.employeeOnHold[0]!.problem).toMatch(/on hold/);
  });

  it('a District name with no exact mapping is an exception — never the employee own district', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(HEADER);
    ws.addRow(row('Faisalabad District/Faisalabad Metropolitan', 'گوٹھ مشترکہ نام', '9090412'));
    ws.addRow(row('Sargodha Metropolitan', 'گوٹھ میٹرو', '9090412'));
    const path = join(dir, 'unknown-district.xlsx');
    await wb.xlsx.writeFile(path);
    const r = await importVillages(await readVillageSheet(path), { dryRun: false, hr });
    // The seed has no Faisalabad unit: the combined name is unknown → "Gaon nahi mile".
    expect(r.unmatchedVillages.map((u) => u.problem)).toEqual([
      `District "Faisalabad District/Faisalabad Metropolitan" not recognised (no fallback to the employee's district)`,
      `District "Sargodha Metropolitan" not recognised (no fallback to the employee's district)`,
    ]);
    expect(r.assigned).toBe(0);
    expect(await Village.exists({ nameKey: 'مشترکہ نام' })).toBeNull();
    expect(await Village.exists({ nameKey: 'میٹرو' })).toBeNull();
  });

  it('without the HR codes the on-hold employee is not recognised — the CLI therefore requires --hr', async () => {
    const without = await importVillages(await readVillageSheet(file), { dryRun: true });
    expect(without.heldCode).toEqual([]);
    expect(without.employeeOnHold).toEqual([]); // with --hr: row 9
    expect(without.unmatchedZimmedar.map((u) => u.row)).toContain(9);
  });
});
