// Builds a throw-away Excel file with invented rows in the OS temp folder (never in the repo).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Unit } from '../../models/unit.js';
import { NOT_CENTRALLY_MANAGED, User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';
import { provisionPakistanAdmin } from '../users/provision.js';
import { importEmployees, readEmployeeSheet, validateRows, ZIMMEDARI_MAP } from './employees.js';

const HEADER = [
  'Ajeer Code',
  'Naam',
  'Walid',
  'Zimmedari',
  'Suba',
  'Division',
  'District',
  'Mobile',
];

let dir: string;
let file: string;

async function writeSheet(rows: (string | number)[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Employees');
  ws.addRow(['Ushar Zimmedaran list (test)']); // a title row above the header is fine
  ws.addRow(HEADER);
  for (const r of rows) ws.addRow(r);
  const path = join(dir, `employees-${rows.length}.xlsx`);
  await wb.xlsx.writeFile(path);
  return path;
}

describe('employee import', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ushr-import-'));
    await seedDemo({ reset: true });
    await User.create({
      ajeerCode: '880007',
      name: 'Existing Zimmedar',
      role: 'zimmedar',
      zimmedari: 'ushar',
      unitCode: 'GHOTKI',
      unitPath: 'PK/INT_SINDH/SUKKUR/GHOTKI',
      passwordHash: 'existing-hash',
      mustChangePassword: false,
      isDemo: false,
    });
    file = await writeSheet([
      // new zimmedar in an existing district (name written with "District")
      [
        '880001/1',
        'Test Zimmedar One',
        'Test Walid',
        'Ushar',
        'Interior Sindh',
        'Sukkur Division',
        'Ghotki District',
        '0300-1112233',
      ],
      // new tehsil-town zimmedar in a brand new suba / division / district
      [
        880002,
        'ٹیسٹ ذمہ دار',
        'ٹیسٹ والد',
        'Tehsil-Town',
        'Balochistan',
        'Quetta',
        'Quetta',
        3001112244,
      ],
      // new district zimmedar of a new district under an existing division
      [
        880003,
        'Test District Head',
        '',
        'District',
        'Interior Sindh',
        'Sukkur',
        'Rohri',
        '03001112255',
      ],
      // existing non-demo zimmedar: data updated, password kept
      [880007, 'Renamed Zimmedar', '', 'Event', 'Interior Sindh', 'Sukkur', 'Ghotki', ''],
      // errors
      ['ABC', 'Bad Code', '', 'Ushar', 'Interior Sindh', 'Sukkur', 'Ghotki', ''],
      [880004, 'Bad Role', '', 'Manager', 'Interior Sindh', 'Sukkur', 'Ghotki', ''],
      [880005, 'No District', '', 'Ushar', 'Interior Sindh', 'Sukkur', '', ''],
      [880006, 'Bad Mobile', '', 'Ushar', 'Interior Sindh', 'Sukkur', 'Ghotki', '12345'],
      ['880001/2', 'Duplicate', '', 'Ushar', 'Interior Sindh', 'Sukkur', 'Ghotki', ''],
      [9090412, 'Real Person', '', 'Ushar', 'Interior Sindh', 'Sukkur', 'Ghotki', ''],
    ]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the header row and cell text', async () => {
    const rows = await readEmployeeSheet(file);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({
      row: 3,
      values: { ajeerCode: '880001/1', zimmedari: 'Ushar' },
    });
  });

  it('reports every bad row with its row number', async () => {
    const plan = validateRows(await readEmployeeSheet(file));
    expect(plan.errors.map((e) => e.row)).toEqual([7, 8, 9, 10, 11]);
    expect(plan.errors.find((e) => e.row === 8)?.message).toMatch(/Zimmedari/);
    expect(plan.errors.find((e) => e.row === 11)?.message).toMatch(/twice/);
    expect(plan.warnings.map((w) => w.ajeerCode)).toEqual(['880007', '9090412']); // no mobile
    expect(plan.otherSuffix.map((r) => r.ajeerCodeFull)).toEqual(['880001/2']);
    // "880001/1" and "880001/2" share the login code 880001: listed for the CTO.
    expect(plan.sameCode).toEqual([
      {
        ajeerCode: '880001',
        rows: [
          expect.objectContaining({ row: 3, ajeerCodeFull: '880001/1', imported: true }),
          expect.objectContaining({ row: 11, ajeerCodeFull: '880001/2', imported: false }),
        ],
      },
    ]);
  });

  it('--dry-run writes nothing', async () => {
    const before = { users: await User.countDocuments(), units: await Unit.countDocuments() };
    const result = await importEmployees(await readEmployeeSheet(file), { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, created: 3, updated: 1 });
    expect(result.newUnits.map((u) => u.path)).toEqual([
      'PK/BALOCHISTAN',
      'PK/BALOCHISTAN/QUETTA',
      'PK/BALOCHISTAN/QUETTA/QUETTA_DIST',
      'PK/INT_SINDH/SUKKUR/ROHRI',
    ]);
    expect(await User.countDocuments()).toBe(before.users);
    expect(await Unit.countDocuments()).toBe(before.units);
  });

  it('imports: new users get password 123 + forced change; existing passwords stay', async () => {
    const before = await User.findOne({ ajeerCode: '880007' }).select('+passwordHash').lean();
    const result = await importEmployees(await readEmployeeSheet(file), { dryRun: false });
    expect(result).toMatchObject({ created: 3, updated: 1 });
    expect(result.errors.find((e) => e.ajeerCode === '9090412')?.message).toMatch(/demo user/);

    const one = await User.findOne({ ajeerCode: '880001' }).select('+passwordHash').lean();
    expect(one).toMatchObject({
      ajeerCodeFull: '880001/1',
      mobileVerified: true,
      role: 'zimmedar',
      zimmedari: 'ushar',
      unitCode: 'GHOTKI',
      unitPath: 'PK/INT_SINDH/SUKKUR/GHOTKI',
      fatherName: 'Test Walid',
      mobile: '03001112233',
      mustChangePassword: true,
      isDemo: false,
    });
    expect(await bcrypt.compare('123', one!.passwordHash)).toBe(true);

    const urdu = await User.findOne({ ajeerCode: '880002' }).lean();
    expect(urdu).toMatchObject({
      nameUr: 'ٹیسٹ ذمہ دار',
      zimmedari: 'tehsil_town',
      mobile: '03001112244',
    });
    expect(urdu?.unitPath).toBe('PK/BALOCHISTAN/QUETTA/QUETTA_DIST');

    const head = await User.findOne({ ajeerCode: '880003' }).lean();
    expect(head).toMatchObject({ role: 'district', unitCode: 'ROHRI' });
    expect(head?.zimmedari).toBeUndefined();

    const after = await User.findOne({ ajeerCode: '880007' }).select('+passwordHash').lean();
    expect(after).toMatchObject({ name: 'Renamed Zimmedar', zimmedari: 'event' });
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.mustChangePassword).toBe(before?.mustChangePassword);

    const demo = await User.findOne({ ajeerCode: '9090412' }).lean();
    expect(demo?.name).toBe('Muhammad Arif');
  });

  it('is idempotent: a second run updates, creates nothing new', async () => {
    const result = await importEmployees(await readEmployeeSheet(file), { dryRun: false });
    expect(result).toMatchObject({ created: 0, updated: 4, newUnits: [], mobileConflicts: [] });
  });

  it('never overwrites a mobile on record; a different file number is reported', async () => {
    // 880001 typed another number at the first login (pending); 880002 lost its number.
    await User.updateOne(
      { ajeerCode: '880001' },
      { $set: { mobile: '03009998877', mobileVerified: false } },
    );
    await User.updateOne({ ajeerCode: '880002' }, { $unset: { mobile: '', mobileVerified: '' } });

    const dry = await importEmployees(await readEmployeeSheet(file), { dryRun: true });
    expect(dry.mobileConflicts).toEqual([
      expect.objectContaining({
        ajeerCode: '880001',
        onRecord: '03009998877',
        inFile: '03001112233',
      }),
    ]);
    const result = await importEmployees(await readEmployeeSheet(file), { dryRun: false });
    expect(result.mobileConflicts.map((c) => c.ajeerCode)).toEqual(['880001']);
    expect(await User.findOne({ ajeerCode: '880001' }).lean()).toMatchObject({
      mobile: '03009998877',
      mobileVerified: false,
    });
    // A missing number is still filled from the file.
    expect(await User.findOne({ ajeerCode: '880002' }).lean()).toMatchObject({
      mobile: '03001112244',
      mobileVerified: true,
    });
  });
});

describe('employee import never creates or changes a Pakistan Admin (CTO 6 Nov 2026)', () => {
  let pdir: string;
  beforeAll(async () => {
    pdir = await mkdtemp(join(tmpdir(), 'ushr-import-pk-'));
    await seedDemo({ reset: true });
    const r = await provisionPakistanAdmin({
      ajeerCode: '881001',
      name: 'Provisioned Admin',
      nominationRef: 'NOM/T/1',
      approvalRef: 'APR/T/1',
      operator: 'Central IT',
      department: 'CENTRAL_IT',
    });
    expect(r.ok).toBe(true);
  });
  afterAll(async () => {
    await rm(pdir, { recursive: true, force: true });
  });

  it('no designation maps to the pakistan role', () => {
    expect(Object.values(ZIMMEDARI_MAP).some((m) => m.role === 'pakistan')).toBe(false);
  });

  it('a "Pakistan" row is refused; a provisioned / pakistan account in the file is never changed', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees');
    ws.addRow(HEADER);
    ws.addRow([881002, 'Wants Pakistan', '', 'Pakistan', 'Interior Sindh', 'Sukkur', 'Ghotki', '']);
    ws.addRow([
      881003,
      'Pakistan Admin',
      '',
      'Pakistan Admin',
      'Interior Sindh',
      'Sukkur',
      'Ghotki',
      '',
    ]);
    // The provisioned admin, listed in the file as an ordinary suba row.
    ws.addRow([
      881001,
      'Renamed By File',
      '',
      'Suba',
      'Interior Sindh',
      'Sukkur',
      'Ghotki',
      '03001234567',
    ]);
    const path = join(pdir, 'pk.xlsx');
    await wb.xlsx.writeFile(path);
    const before = await User.findOne({ ajeerCode: '881001' }).lean();

    const result = await importEmployees(await readEmployeeSheet(path), { dryRun: false });
    expect(result).toMatchObject({ created: 0, updated: 0 });
    const msgs = result.errors.map((e) => `${e.ajeerCode}: ${e.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^881002: .*Zimmedari/),
        expect.stringMatching(/^881003: .*Zimmedari/),
        expect.stringMatching(/^881001: .*centrally provisioned/),
      ]),
    );
    expect(await User.countDocuments({ ajeerCode: { $in: ['881002', '881003'] } })).toBe(0);
    const after = await User.findOne({ ajeerCode: '881001' }).lean();
    expect(after).toMatchObject({
      role: 'pakistan',
      name: 'Provisioned Admin',
      unitPath: 'PK',
      department: 'CENTRAL_IT',
    });
    expect(after!.mobile).toBeUndefined();
    expect(after!.updatedAt).toEqual(before!.updatedAt);
    expect(await User.countDocuments({ role: 'pakistan', isDemo: false })).toBe(1);
  });

  it('the upsert filter itself never matches a centrally managed account (fails instead)', async () => {
    await expect(
      User.updateOne(
        { ajeerCode: '881001', ...NOT_CENTRALLY_MANAGED },
        { $set: { role: 'district' } },
        { upsert: true },
      ),
    ).rejects.toThrow(/duplicate key/);
    expect((await User.findOne({ ajeerCode: '881001' }).lean())!.role).toBe('pakistan');
    // An ordinary upsert through the same filter stores no department / provisioned field.
    await User.updateOne(
      { ajeerCode: '881009', ...NOT_CENTRALLY_MANAGED },
      {
        $set: {
          name: 'Plain',
          role: 'zimmedar',
          unitCode: 'GHOTKI',
          unitPath: 'PK/INT_SINDH/SUKKUR/GHOTKI',
        },
        $setOnInsert: { passwordHash: 'x' },
      },
      { upsert: true },
    );
    const plain = await User.collection.findOne({ ajeerCode: '881009' });
    expect(plain).not.toHaveProperty('department');
    expect(plain).not.toHaveProperty('provisioned');
  });
});
