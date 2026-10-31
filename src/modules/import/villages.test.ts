// Invented rows in a throw-away Excel file in the OS temp folder (never in the repo).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';
import { importVillages, readVillageSheet, writeVillageReport } from './villages.js';

let dir: string;
let file: string;
let otherCode: string;
let existing: { name: string; nameKey: string };

const HEADER = ['Gaon ka naam', 'Tehsil', 'District', 'Zimmedar Ajeer Code'];

describe('village import', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ushr-villages-'));
    await seedDemo({ reset: true });
    const other = await User.findOne({
      role: 'zimmedar',
      unitCode: 'GHOTKI',
      ajeerCode: { $ne: '9090412' },
    }).lean();
    otherCode = other!.ajeerCode;
    const seeded = await Village.findOne({ districtCode: 'GHOTKI' }).sort({ nameKey: -1 }).lean();
    existing = { name: seeded!.name, nameKey: seeded!.nameKey };

    const wb = new ExcelJS.Workbook();
    // A "Location" sheet (in the real file: login passwords) comes first and looks like a village
    // list — it must never be read.
    const location = wb.addWorksheet('Location');
    location.addRow(HEADER);
    location.addRow(['گوٹھ خفیہ', 'X', 'Ghotki', '9090412']);
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(HEADER);
    for (const r of [
      ['گوٹھ نیا گاؤں', 'Ubauro', 'Ghotki', '9090412/1'], // new, code with "/n"
      ['گوٹھ   نیا گاؤں', 'Ubauro', 'Ghotki', '9090412'], // same village again (donor rows)
      ['نیا گاؤں', 'Ubauro', 'Ghotki', otherCode], // same nameKey, other zimmedar → conflict
      [existing.name, 'Ghotki', 'Ghotki District', otherCode], // existing seeded village
      ['گوٹھ نام سے', 'Ghotki', 'Ghotki', 'Muhammad Arif'], // zimmedar by name
      ['گوٹھ بے نام', 'Ghotki', 'Ghotki', '55555'], // unknown code → unassigned
      ['گوٹھ ضلعی', 'Ghotki', '', '9040001'], // a district user → district pool
      ['گوٹھ کہیں نہیں', 'X', 'Atlantis', ''], // district not found → not imported
      ['', 'X', 'Ghotki', '9090412'], // no village name
      ['گوٹھ رومن', 'X', 'District Naahro Feroze', ''], // Roman spelling via district-names.csv
    ]) {
      ws.addRow(r);
    }
    file = join(dir, 'villages.xlsx');
    await wb.xlsx.writeFile(file);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('never reads the "Location" sheet', async () => {
    const rows = await readVillageSheet(file);
    expect(rows.some((r) => r.values.village === 'گوٹھ خفیہ')).toBe(false);
    expect(rows).toHaveLength(10);
  });

  it('--dry-run reports everything and writes nothing', async () => {
    const before = await Village.countDocuments();
    const result = await importVillages(await readVillageSheet(file), { dryRun: true });
    expect(result).toMatchObject({
      dryRun: true,
      rows: 10,
      villages: 6,
      duplicateRows: 2,
      created: 5,
      updated: 1,
      assigned: 3,
    });
    expect(result.unmatchedVillages.map((u) => u.row)).toEqual([9]);
    expect(result.noName.map((u) => u.row)).toEqual([10]);
    expect(result.districtPool.map((u) => u.problem)).toEqual([
      'Ajeer code 9040001 is a district user → district pool',
    ]);
    expect(result.unmatchedZimmedar.map((u) => u.problem)).toEqual([
      'Ajeer code 55555 not found (import employees first)',
      'No zimmedar given',
    ]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        village: 'گوٹھ نیا گاؤں',
        chosen: expect.stringContaining('9090412'),
      }),
    ]);
    expect(await Village.countDocuments()).toBe(before);
  });

  it('imports approved villages assigned to their zimmedar; supervisor villages stay in the pool', async () => {
    const arif = await User.findOne({ ajeerCode: '9090412' }).lean();
    const other = await User.findOne({ ajeerCode: otherCode }).lean();
    await importVillages(await readVillageSheet(file), { dryRun: false });

    const nayaGaon = await Village.findOne({ nameKey: 'نیا گاؤں', districtCode: 'GHOTKI' }).lean();
    expect(nayaGaon).toMatchObject({ status: 'approved', tehsil: 'Ubauro', name: 'گوٹھ نیا گاؤں' });
    expect(String(nayaGaon!.assignedTo)).toBe(String(arif!._id));

    const rahim = await Village.findOne({
      nameKey: existing.nameKey,
      districtCode: 'GHOTKI',
    }).lean();
    expect(String(rahim!.assignedTo)).toBe(String(other!._id));

    const byName = await Village.findOne({ nameKey: 'نام سے' }).lean();
    expect(String(byName!.assignedTo)).toBe(String(arif!._id));

    const unassigned = await Village.findOne({ nameKey: 'بے نام' }).lean();
    expect(unassigned?.assignedTo).toBeUndefined();
    const pool = await Village.findOne({ nameKey: 'ضلعی' }).lean();
    expect(pool).toMatchObject({ status: 'approved', districtCode: 'GHOTKI' });
    expect(pool?.assignedTo).toBeUndefined();
    expect(await Village.findOne({ nameKey: 'رومن' }).lean()).toMatchObject({
      districtCode: 'NAUSHAHRO_FEROZE',
    });
    expect(await Village.exists({ nameKey: 'کہیں نہیں' })).toBeNull();
  });

  it('is idempotent', async () => {
    const result = await importVillages(await readVillageSheet(file), { dryRun: false });
    expect(result).toMatchObject({ created: 0, updated: 6 });
  });

  it('writes the Excel report', async () => {
    const result = await importVillages(await readVillageSheet(file), { dryRun: true });
    const out = join(dir, 'report.xlsx');
    await writeVillageReport(result, out);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Gaon nahi mile',
      'Bina naam',
      'District pool',
      'Zimmedar nahi mila',
      'Aik gaon, kai zimmedar',
    ]);
    expect(wb.getWorksheet('Gaon nahi mile')!.rowCount).toBe(2);
    expect(wb.getWorksheet('Bina naam')!.rowCount).toBe(2);
  });
});
