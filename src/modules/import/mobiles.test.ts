// Builds a throw-away Excel file with invented rows in the OS temp folder (never in the repo).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';
import { importMobiles, readMobileSheet } from './mobiles.js';

let dir: string;
let file: string;

async function addUser(ajeerCode: string, mobile?: string): Promise<void> {
  await User.create({
    ajeerCode,
    name: `Test ${ajeerCode}`,
    role: 'zimmedar',
    zimmedari: 'ushar',
    unitCode: 'GHOTKI',
    unitPath: 'PK/INT_SINDH/SUKKUR/GHOTKI',
    passwordHash: 'x',
    mustChangePassword: true,
    isDemo: false,
    ...(mobile ? { mobile, mobileVerified: true } : {}),
  });
}

describe('mobile import (KPI file)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ushr-mobiles-'));
    await seedDemo({ reset: true });
    await addUser('770001');
    await addUser('770002', '03001110002');
    await addUser('770003', '03001110003');
    await addUser('770004');
    await addUser('770005');

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('KPI');
    ws.addRow(['KPI (test)']);
    ws.addRow(['عملہ کوڈ', 'نام', 'رجسٹرڈ موبائل نمبر']);
    ws.addRow(['770001/1', 'a', '0300-1110001']); // set
    ws.addRow(['770002', 'b', '03001110002']); // same as on record
    ws.addRow(['770003', 'c', '03009990003']); // different → not changed
    ws.addRow(['770004', 'd', '123']); // invalid
    ws.addRow(['770006', 'e', '03001110006']); // no such user
    ws.addRow(['9090412', 'demo', '03001110007']); // demo user → ignored
    file = join(dir, 'kpi.xlsx');
    await wb.xlsx.writeFile(file);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('dry run plans, writes nothing', async () => {
    const result = await importMobiles(await readMobileSheet(file), { dryRun: true });
    expect(result.set).toEqual([{ ajeerCode: '770001', mobile: '03001110001' }]);
    expect(result.unchanged).toBe(1);
    expect(result.different).toEqual([
      { ajeerCode: '770003', onRecord: '03001110003', inFile: '03009990003' },
    ]);
    expect(result.problems.map((p) => p.ajeerCode)).toEqual(['770004', '770006', '9090412']);
    expect(result.stillMissing.map((u) => u.ajeerCode)).toEqual(['770004', '770005']);
    expect((await User.findOne({ ajeerCode: '770001' }).lean())?.mobile).toBeUndefined();
  });

  it('sets only empty numbers, as verified', async () => {
    await importMobiles(await readMobileSheet(file), { dryRun: false });
    expect(await User.findOne({ ajeerCode: '770001' }).lean()).toMatchObject({
      mobile: '03001110001',
      mobileVerified: true,
    });
    expect((await User.findOne({ ajeerCode: '770003' }).lean())?.mobile).toBe('03001110003');
    expect((await User.findOne({ ajeerCode: '9090412' }).lean())?.mobile).toBe('03000000000');
  });
});
