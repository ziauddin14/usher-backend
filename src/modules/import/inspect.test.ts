// Invented rows in a throw-away Excel file in the OS temp folder (never in the repo).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectFile } from './inspect.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ushr-inspect-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('inspect an official file (no database)', () => {
  it('employees: header, mapping, held /2 /3, unknown zimmedari, no personal data in the output', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('HR');
    ws.addRow(['Ushar staff list']);
    ws.addRow([
      'اجیر کوڈ',
      'نام',
      'ذمہ داری',
      'صوبہ',
      'ڈویژن',
      'ضلع',
      'موبائل',
      'ٹاؤن',
      'Joining date',
    ]);
    ws.addRow([
      '850001/1',
      'Invented A',
      'عشر ذمہ دار',
      'Sindh',
      'Sukkur',
      'Ghotki',
      '03001112233',
      'گھوٹکی ٹاؤن',
    ]);
    ws.addRow(['850001/2', 'Invented B', 'عشر ذمہ دار', 'Sindh', 'Sukkur', 'Ghotki', '']);
    ws.addRow(['850002/3', 'Invented C', 'Manager', 'Sindh', 'Sukkur', 'Ghotki', '']);
    ws.addRow(['850003', 'Invented D', 'Manager', 'Sindh', 'Sukkur', 'Rohri', '']);
    ws.addRow([
      '850004',
      'Invented T',
      'ٹاؤن /تحصیل ذمہ دار',
      'Sindh',
      'Sukkur',
      'Ghotki',
      '',
      'گھوٹکی ٹاؤن',
    ]);
    const file = join(dir, 'hr.xlsx');
    await wb.xlsx.writeFile(file);

    const report = await inspectFile(file, 'employees');
    expect(report.kind).toBe('employees');
    if (report.kind !== 'employees') return;
    expect(report.sheets[0]).toMatchObject({
      name: 'HR',
      headerRow: 2,
      dataRows: 5,
      mapped: { ajeerCode: 'اجیر کوڈ', zimmedari: 'ذمہ داری', mobile: 'موبائل', town: 'ٹاؤن' },
      unmapped: ['Joining date'],
    });
    expect(report).toMatchObject({
      rows: 5,
      importable: 2, // the Ushar and its Tehsil/Town Zimmedar
      sameCode: 1,
      onHold: { noTehsilParent: 0 },
    });
    expect(report.heldSuffix).toEqual([
      { suffix: '/2', n: 1 },
      { suffix: '/3', n: 1 },
    ]);
    expect(report.zimmedari).toEqual(
      expect.arrayContaining([
        { value: 'عشر ذمہ دار', n: 2, mapsTo: 'zimmedar / ushar' },
        { value: 'Manager', n: 2, mapsTo: null },
      ]),
    );
    expect(report.units).toEqual({ suba: 1, division: 1, district: 2 });
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/Invented|850001|0300/);
  });

  it('villages: never the Location sheet; zimmedar by code / name / none', async () => {
    const wb = new ExcelJS.Workbook();
    const loc = wb.addWorksheet('Location');
    loc.addRow(['گاؤں کا نام', 'Password']);
    loc.addRow(['خفیہ', 'secret']);
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['گاؤں کا نام', 'تحصیل', 'ضلع', 'اجیر کوڈ']);
    ws.addRow(['گوٹھ الف', 'X', 'Ghotki', '9090412']);
    ws.addRow(['گوٹھ ب', 'X', 'Ghotki', 'Some Name']);
    ws.addRow(['گوٹھ ج', 'X', '', '']);
    ws.addRow(['', 'X', 'Ghotki', '9090412']);
    const file = join(dir, 'gaon.xlsx');
    await wb.xlsx.writeFile(file);

    const report = await inspectFile(file, 'villages');
    if (report.kind !== 'villages') throw new Error('kind');
    expect(report.sheets.map((s) => s.name)).toEqual(['Sheet1']);
    expect(report).toMatchObject({
      rows: 4,
      noName: 1,
      withAjeerCode: 1,
      withZimmedarNameOnly: 1,
      withoutZimmedar: 1,
      withoutDistrict: 1,
    });
    expect(JSON.stringify(report)).not.toContain('secret');
  });
});
